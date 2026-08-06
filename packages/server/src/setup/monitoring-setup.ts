import { findServerById } from "@dokploy/server/services/server";
import { getWebServerSettings } from "@dokploy/server/services/web-server-settings";
import type { ContainerCreateOptions } from "dockerode";
import { IS_CLOUD } from "../constants";
import { getDokployImageTag } from "../services/settings";
import { pullImageUnderBuildAdmission } from "../utils/docker/utils";
import { withHostBuildAdmission } from "../utils/process/build-admission";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";
import { getRemoteDocker } from "../utils/servers/remote-docker";

export const setupMonitoring = async (serverId: string) => {
	const server = await findServerById(serverId);

	const containerName = "dokploy-monitoring";
	let imageName = "dokploy/monitoring:latest";

	if (
		(getDokployImageTag() !== "latest" ||
			process.env.NODE_ENV === "development") &&
		!IS_CLOUD
	) {
		imageName = "dokploy/monitoring:canary";
	}

	const settings: ContainerCreateOptions = {
		name: containerName,
		Env: [`METRICS_CONFIG=${JSON.stringify(server?.metricsConfig)}`],
		Image: imageName,
		HostConfig: {
			// Memory: 100 * 1024 * 1024, // 100MB en bytes
			// PidMode: "host",
			// CapAdd: ["NET_ADMIN", "SYS_ADMIN"],
			// Privileged: true,
			RestartPolicy: {
				Name: "always",
			},
			PortBindings: {
				[`${server.metricsConfig.server.port}/tcp`]: [
					{
						HostPort: server.metricsConfig.server.port.toString(),
					},
				],
			},
			Binds: [
				"/var/run/docker.sock:/var/run/docker.sock:ro",
				"/sys:/host/sys:ro",
				"/etc/os-release:/etc/os-release:ro",
				"/proc:/host/proc:ro",
				"/etc/dokploy/monitoring/monitoring.db:/app/monitoring.db",
			],
			NetworkMode: "host",
		},
		ExposedPorts: {
			[`${server.metricsConfig.server.port}/tcp`]: {},
		},
	};
	const docker = await getRemoteDocker(serverId);
	try {
		await execAsyncRemote(
			serverId,
			"mkdir -p /etc/dokploy/monitoring && touch /etc/dokploy/monitoring/monitoring.db",
		);
	} catch (error) {
		console.log("Monitoring Not Found: Starting ", error);
		return;
	}

	await withHostBuildAdmission(
		{ serverId, operation: "remote-monitoring-setup" },
		async (context) => {
			try {
				await pullImageUnderBuildAdmission({
					context,
					dockerImage: imageName,
					serverId,
				});

				// Check if container exists
				const container = docker.getContainer(containerName);
				try {
					await container.inspect();
					context.assertLockHeld();
					await container.remove({ force: true });
					context.assertLockHeld();
					console.log("Removed existing container");
				} catch {
					// Container doesn't exist, continue
				}

				context.assertLockHeld();
				await docker.createContainer(settings);
				context.assertLockHeld();
				const newContainer = docker.getContainer(containerName);
				await newContainer.start();
				context.assertLockHeld();

				console.log("Monitoring Started ");
			} catch (error) {
				context.assertLockHeld();
				console.log("Monitoring Not Found: Starting ", error);
			}
		},
	);
};

export const setupWebMonitoring = async () => {
	const webServerSettings = await getWebServerSettings();

	const containerName = "dokploy-monitoring";
	let imageName = "dokploy/monitoring:latest";

	if (
		(getDokployImageTag() !== "latest" ||
			process.env.NODE_ENV === "development") &&
		!IS_CLOUD
	) {
		imageName = "dokploy/monitoring:canary";
	}

	const settings: ContainerCreateOptions = {
		name: containerName,
		Env: [`METRICS_CONFIG=${JSON.stringify(webServerSettings?.metricsConfig)}`],
		Image: imageName,
		HostConfig: {
			// Memory: 100 * 1024 * 1024, // 100MB en bytes
			// PidMode: "host",
			// CapAdd: ["NET_ADMIN", "SYS_ADMIN"],
			// Privileged: true,
			RestartPolicy: {
				Name: "always",
			},
			PortBindings: {
				[`${webServerSettings?.metricsConfig?.server?.port}/tcp`]: [
					{
						HostPort: webServerSettings?.metricsConfig?.server?.port.toString(),
					},
				],
			},
			Binds: [
				"/var/run/docker.sock:/var/run/docker.sock:ro",
				"/sys:/host/sys:ro",
				"/etc/os-release:/etc/os-release:ro",
				"/proc:/host/proc:ro",
				"/etc/dokploy/monitoring/monitoring.db:/app/monitoring.db",
			],
			// NetworkMode: "host",
		},
		ExposedPorts: {
			[`${webServerSettings?.metricsConfig?.server?.port}/tcp`]: {},
		},
	};
	const docker = await getRemoteDocker();
	try {
		await execAsync(
			"mkdir -p /etc/dokploy/monitoring && touch /etc/dokploy/monitoring/monitoring.db",
		);
	} catch (error) {
		console.log("Monitoring Not Found: Starting ", error);
		return;
	}

	await withHostBuildAdmission(
		{ serverId: null, operation: "web-monitoring-setup" },
		async (context) => {
			try {
				await pullImageUnderBuildAdmission({
					context,
					dockerImage: imageName,
					serverId: null,
				});

				const container = docker.getContainer(containerName);
				try {
					await container.inspect();
					context.assertLockHeld();
					await container.remove({ force: true });
					context.assertLockHeld();
					console.log("Removed existing container");
				} catch {}

				context.assertLockHeld();
				await docker.createContainer(settings);
				context.assertLockHeld();
				const newContainer = docker.getContainer(containerName);
				await newContainer.start();
				context.assertLockHeld();

				console.log("Monitoring Started ");
			} catch (error) {
				context.assertLockHeld();
				console.log("Monitoring Not Found: Starting ", error);
			}
		},
	);
};
