import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { ACCESS_LOG_RETAINED_LINES, paths } from "@dokploy/server/constants";
import {
	getWebServerProvider,
	getWebServerSettings,
	updateWebServerSettings,
} from "@dokploy/server/services/web-server-settings";
import { scheduledJobs, scheduleJob } from "node-schedule";
import { quote } from "shell-quote";
import { syncCaddy, syncCaddyInBackground } from "../caddy/sync";
import { execAsync } from "../process/execAsync";
import { readMonitoringConfig } from "../traefik/application";

const LOG_CLEANUP_JOB_NAME = "access-log-cleanup";

// CADDY_REQUEST_LOG, as Dokploy sees it.
const caddyRequestLogPath = () =>
	path.join(paths().MAIN_CADDY_PATH, "access.log");

/**
 * The access log of the proxy that serves the Dokploy host: Traefik's as
 * upstream reads it, or the last lines of Caddy's
 */
export const readRequestLog = async (readAll = false) => {
	if ((await getWebServerProvider()) !== "caddy") {
		return readMonitoringConfig(readAll);
	}
	const file = caddyRequestLogPath();
	if (!fs.existsSync(file)) return "";

	const recent: string[] = [];
	const lines = createInterface({
		input: fs.createReadStream(file, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
		recent.push(line);
		if (recent.length > ACCESS_LOG_RETAINED_LINES) recent.shift();
	}
	return recent.length ? `${recent.join("\n")}\n` : "";
};

/**
 * Turn Caddy's request log on or off. Caddy has loaded the change when this
 * returns, and a change it refuses is taken back
 */
export const setCaddyRequestLogs = async (enable: boolean) => {
	const before = !!(await getWebServerSettings())?.requestLogsEnabled;
	await updateWebServerSettings({ requestLogsEnabled: enable });
	try {
		await syncCaddy(null, true);
	} catch (error) {
		await updateWebServerSettings({ requestLogsEnabled: before });
		syncCaddyInBackground();
		throw error;
	}
};

export const startLogCleanup = async (
	cronExpression = "0 0 * * *",
): Promise<boolean> => {
	try {
		const validationJob = scheduleJob(
			`${LOG_CLEANUP_JOB_NAME}-validation`,
			cronExpression,
			() => {},
		);
		if (!validationJob) {
			return false;
		}
		validationJob.cancel();

		const existingJob = scheduledJobs[LOG_CLEANUP_JOB_NAME];
		if (existingJob) {
			existingJob.cancel();
		}

		const cleanupJob = scheduleJob(
			LOG_CLEANUP_JOB_NAME,
			cronExpression,
			async () => {
				try {
					const caddy = (await getWebServerProvider()) === "caddy";
					const accessLogPath = caddy
						? caddyRequestLogPath()
						: path.join(paths().DYNAMIC_TRAEFIK_PATH, "access.log");

					if (!fs.existsSync(accessLogPath)) {
						console.error("Access log file does not exist");
						return;
					}

					const quotedAccessLogPath = quote([accessLogPath]);
					const quotedTempPath = quote([`${accessLogPath}.tmp`]);
					if (caddy) {
						// Caddy keeps the file open and has no signal for reopening
						// it, so the file is rewritten in place.
						await execAsync(
							`tail -n ${ACCESS_LOG_RETAINED_LINES} ${quotedAccessLogPath} > ${quotedTempPath} && cat ${quotedTempPath} > ${quotedAccessLogPath} && rm ${quotedTempPath}`,
						);
						return;
					}

					await execAsync(
						`tail -n ${ACCESS_LOG_RETAINED_LINES} ${quotedAccessLogPath} > ${quotedTempPath} && mv ${quotedTempPath} ${quotedAccessLogPath}`,
					);

					// Traefik can run as a standalone container ("dokploy-traefik") or a
					// swarm service task ("dokploy-traefik.1.<task-id>"), so resolve the
					// running container id dynamically instead of assuming the name.
					const { stdout: containerId } = await execAsync(
						'docker ps -q --filter "name=dokploy-traefik" --filter "status=running" | head -n 1',
					);
					const traefikContainerId = containerId.trim();
					if (!traefikContainerId) {
						console.error("Traefik container not found, skipping log reopen");
						return;
					}
					await execAsync(`docker exec ${traefikContainerId} kill -USR1 1`);
				} catch (error) {
					console.error("Error during log cleanup:", error);
				}
			},
		);
		if (!cleanupJob) {
			return false;
		}

		await updateWebServerSettings({
			logCleanupCron: cronExpression,
		});

		return true;
	} catch (error) {
		console.error("Error starting log cleanup:", error);
		return false;
	}
};

export const stopLogCleanup = async (): Promise<boolean> => {
	try {
		const existingJob = scheduledJobs[LOG_CLEANUP_JOB_NAME];
		if (existingJob) {
			existingJob.cancel();
		}

		// Update database
		await updateWebServerSettings({
			logCleanupCron: null,
		});

		return true;
	} catch (error) {
		console.error("Error stopping log cleanup:", error);
		return false;
	}
};

export const getLogCleanupStatus = async (): Promise<{
	enabled: boolean;
	cronExpression: string | null;
}> => {
	const settings = await getWebServerSettings();
	const cronExpression = settings?.logCleanupCron ?? null;
	return {
		enabled: cronExpression !== null,
		cronExpression,
	};
};
