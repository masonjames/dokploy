import { Readable } from "node:stream";
import { beforeEach, expect, test, vi } from "vitest";

const existsSyncMock = vi.hoisted(() => vi.fn());
const createReadStreamMock = vi.hoisted(() => vi.fn());
const statSyncMock = vi.hoisted(() => vi.fn());
const caddySwitchMock = vi.hoisted(() => vi.fn());
const getWebServerProviderMock = vi.hoisted(() => vi.fn());
const syncCaddyMock = vi.hoisted(() => vi.fn());
const syncCaddyInBackgroundMock = vi.hoisted(() => vi.fn());
const readMonitoringConfigMock = vi.hoisted(() => vi.fn());
const execAsyncMock = vi.hoisted(() => vi.fn());
const getWebServerSettingsMock = vi.hoisted(() => vi.fn());
const updateWebServerSettingsMock = vi.hoisted(() => vi.fn());
const scheduleJobMock = vi.hoisted(() => vi.fn());
const scheduledJobsMock = vi.hoisted(() => ({}) as Record<string, any>);
let scheduledCallback: (() => Promise<void>) | undefined;

vi.mock("node:fs", () => ({
	default: {
		existsSync: existsSyncMock,
		createReadStream: createReadStreamMock,
		statSync: statSyncMock,
	},
	existsSync: existsSyncMock,
}));

vi.mock("node-schedule", () => ({
	scheduledJobs: scheduledJobsMock,
	scheduleJob: scheduleJobMock,
}));

vi.mock("@dokploy/server/constants", () => ({
	ACCESS_LOG_RETAINED_LINES: 1000,
	paths: () => ({
		DYNAMIC_TRAEFIK_PATH: "/etc/dokploy/traefik/dynamic",
		MAIN_CADDY_PATH: "/etc/dokploy/caddy",
	}),
}));

vi.mock("@dokploy/server/services/web-server-settings", () => ({
	getWebServerProvider: getWebServerProviderMock,
	getWebServerSettings: getWebServerSettingsMock,
	updateWebServerSettings: updateWebServerSettingsMock,
}));

vi.mock("@dokploy/server/utils/caddy/sync", () => ({
	caddySwitch: caddySwitchMock,
	syncCaddy: syncCaddyMock,
	syncCaddyInBackground: syncCaddyInBackgroundMock,
}));

vi.mock("@dokploy/server/utils/traefik/application", () => ({
	readMonitoringConfig: readMonitoringConfigMock,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: execAsyncMock,
}));

import {
	readRequestLog,
	setCaddyRequestLogs,
	startLogCleanup,
} from "@dokploy/server/utils/access-log/handler";

beforeEach(() => {
	vi.clearAllMocks();
	for (const key of Object.keys(scheduledJobsMock)) {
		delete scheduledJobsMock[key];
	}
	scheduledCallback = undefined;
	existsSyncMock.mockReturnValue(true);
	getWebServerProviderMock.mockResolvedValue("traefik");
	statSyncMock.mockReturnValue({ size: 100 });
	execAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });
	updateWebServerSettingsMock.mockResolvedValue({});
	scheduleJobMock.mockImplementation((name, _cron, callback) => {
		if (name === "access-log-cleanup") {
			scheduledCallback = callback;
		}
		return { cancel: vi.fn() };
	});
});

test("keeps Traefik access-log cleanup and signal behavior", async () => {
	execAsyncMock.mockImplementation(async (command: string) => {
		if (command.startsWith("docker ps -q")) {
			return { stdout: "abc123\n", stderr: "" };
		}
		return { stdout: "", stderr: "" };
	});

	await startLogCleanup("0 0 * * *");
	await scheduledCallback?.();

	expect(execAsyncMock).toHaveBeenNthCalledWith(
		1,
		"tail -n 1000 /etc/dokploy/traefik/dynamic/access.log > /etc/dokploy/traefik/dynamic/access.log.tmp && mv /etc/dokploy/traefik/dynamic/access.log.tmp /etc/dokploy/traefik/dynamic/access.log",
	);
	expect(execAsyncMock).toHaveBeenNthCalledWith(
		2,
		'docker ps -q --filter "name=dokploy-traefik" --filter "status=running" | head -n 1',
	);
	expect(execAsyncMock).toHaveBeenNthCalledWith(
		3,
		"docker exec abc123 kill -USR1 1",
	);
});

test("skips Traefik log reopen when no running container is found", async () => {
	await startLogCleanup("0 0 * * *");
	await scheduledCallback?.();

	expect(execAsyncMock).toHaveBeenCalledTimes(2);
	expect(execAsyncMock).not.toHaveBeenCalledWith(
		expect.stringContaining("kill -USR1"),
	);
});

test("rewrites Caddy's log in place, which keeps Caddy writing to it", async () => {
	getWebServerProviderMock.mockResolvedValue("caddy");

	await startLogCleanup("0 0 * * *");
	await scheduledCallback?.();

	expect(execAsyncMock.mock.calls).toEqual([
		[
			"tail -n 1000 /etc/dokploy/caddy/access.log > /etc/dokploy/caddy/access.log.tmp && cat /etc/dokploy/caddy/access.log.tmp > /etc/dokploy/caddy/access.log && rm /etc/dokploy/caddy/access.log.tmp",
		],
	]);
});

test("does not persist invalid cleanup cron schedules", async () => {
	const existingCancel = vi.fn();
	scheduledJobsMock["access-log-cleanup"] = { cancel: existingCancel };
	scheduleJobMock.mockReturnValueOnce(null);

	const result = await startLogCleanup("not a cron");

	expect(result).toBe(false);
	expect(existingCancel).not.toHaveBeenCalled();
	expect(updateWebServerSettingsMock).not.toHaveBeenCalled();
});

test("reads Traefik's log as upstream does", async () => {
	readMonitoringConfigMock.mockResolvedValue("traefik lines");

	expect(await readRequestLog(true)).toBe("traefik lines");
	expect(readMonitoringConfigMock).toHaveBeenCalledWith(true);
	expect(createReadStreamMock).not.toHaveBeenCalled();
});

test("reads the last lines of Caddy's log and skips what is not an entry", async () => {
	getWebServerProviderMock.mockResolvedValue("caddy");
	const entries = Array.from({ length: 1002 }, (_, n) => `{"n":${n}}`);
	createReadStreamMock.mockReturnValue(
		Readable.from([["half an entr", ...entries, ""].join("\n")]),
	);

	const log = await readRequestLog();

	expect(createReadStreamMock).toHaveBeenCalledWith(
		"/etc/dokploy/caddy/access.log",
		{ encoding: "utf8", start: 0 },
	);
	expect(log?.split("\n").slice(0, 1)).toEqual(['{"n":2}']);
	expect(log?.endsWith('{"n":1001}\n')).toBe(true);
	expect(readMonitoringConfigMock).not.toHaveBeenCalled();
});

test("reads only the end of a large log, from the first whole entry", async () => {
	getWebServerProviderMock.mockResolvedValue("caddy");
	statSyncMock.mockReturnValue({ size: 5_000_000 });
	createReadStreamMock.mockReturnValue(
		Readable.from(['"tail":"of an entry"}\n{"n":1}\n{"n":2}\n']),
	);

	expect(await readRequestLog()).toBe('{"n":1}\n{"n":2}\n');
	expect(createReadStreamMock).toHaveBeenCalledWith(
		"/etc/dokploy/caddy/access.log",
		{ encoding: "utf8", start: 5_000_000 - 1000 * 4096 },
	);
});

test("turns Caddy's request log on once Caddy has loaded it", async () => {
	getWebServerSettingsMock.mockResolvedValue({ requestLogsEnabled: false });

	await setCaddyRequestLogs(true);

	expect(updateWebServerSettingsMock.mock.calls).toEqual([
		[{ requestLogsEnabled: true }],
	]);
	expect(syncCaddyMock).toHaveBeenCalledWith(null, true);
});

test("takes the change back when Caddy refuses it", async () => {
	getWebServerSettingsMock.mockResolvedValue({ requestLogsEnabled: false });
	syncCaddyMock.mockRejectedValueOnce(new Error("Caddy did not load it"));

	await expect(setCaddyRequestLogs(true)).rejects.toThrow(
		"Caddy did not load it",
	);

	expect(updateWebServerSettingsMock.mock.calls).toEqual([
		[{ requestLogsEnabled: true }],
		[{ requestLogsEnabled: false }],
	]);
	expect(syncCaddyInBackgroundMock).toHaveBeenCalledOnce();
});

test("is refused while a switch is running, when Caddy's answer would be lost", async () => {
	caddySwitchMock.mockReturnValueOnce({ status: "running" });

	await expect(setCaddyRequestLogs(true)).rejects.toThrow(
		"A switch is running on this server",
	);

	expect(updateWebServerSettingsMock).not.toHaveBeenCalled();
	expect(syncCaddyMock).not.toHaveBeenCalled();
});
