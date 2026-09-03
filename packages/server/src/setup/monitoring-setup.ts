import { findServerById } from "@dokploy/server/services/server";
import { getWebServerSettings } from "@dokploy/server/services/web-server-settings";
import type { CreateServiceOptions } from "dockerode";
import { IS_CLOUD } from "../constants";
import { getDokployImageTag } from "../services/settings";
import { pullImageUnderBuildAdmission } from "../utils/docker/utils";
import {
	type BuildAdmissionContext,
	withHostBuildAdmission,
} from "../utils/process/build-admission";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";
import { getRemoteDocker } from "../utils/servers/remote-docker";

const getMonitoringImage = () => {
	let imageName = "dokploy/monitoring:latest";

	if (
		(getDokployImageTag() !== "latest" ||
			process.env.NODE_ENV === "development") &&
		!IS_CLOUD
	) {
		imageName = "dokploy/monitoring:canary";
	}

	return imageName;
};

// Swarm tasks are dokploy-monitoring.<slot>.<id>, so this only matches the
// pre-v0.30.0 standalone container. A cleanup failure must not block the deploy.
const removeLegacyContainer = async (
	docker: Awaited<ReturnType<typeof getRemoteDocker>>,
	serviceName: string,
) => {
	try {
		await docker.getContainer(serviceName).remove({ force: true });
		console.log("Removed legacy monitoring container ✅");
	} catch (error: any) {
		if (error?.statusCode !== 404) {
			console.warn(
				`Could not remove legacy monitoring container: ${error?.message ?? error}`,
			);
		}
	}
};

const deployMonitoringService = async (
	docker: Awaited<ReturnType<typeof getRemoteDocker>>,
	serviceName: string,
	settings: CreateServiceOptions,
	context: BuildAdmissionContext,
) => {
	await removeLegacyContainer(docker, serviceName);

	try {
		const service = docker.getService(serviceName);
		const inspect = await service.inspect();
		context.assertLockHeld();
		await service.update({
			version: Number.parseInt(inspect.Version.Index),
			...settings,
			TaskTemplate: {
				...settings.TaskTemplate,
				ForceUpdate: (inspect.Spec.TaskTemplate.ForceUpdate ?? 0) + 1,
			},
		});
		context.assertLockHeld();
		console.log("Monitoring Updated ✅");
	} catch (error: any) {
		if (error?.statusCode && error.statusCode !== 404) {
			throw error;
		}
		context.assertLockHeld();
		await docker.createService(settings);
		context.assertLockHeld();
		console.log("Monitoring Started ✅");
	}
};

export const setupMonitoring = async (serverId: string) => {
	const server = await findServerById(serverId);

	const serviceName = "dokploy-monitoring";
	const imageName = getMonitoringImage();

	const settings: CreateServiceOptions = {
		Name: serviceName,
		TaskTemplate: {
			ContainerSpec: {
				Image: imageName,
				Env: [`METRICS_CONFIG=${JSON.stringify(server?.metricsConfig)}`],
				Mounts: [
					{
						Type: "bind",
						Source: "/var/run/docker.sock",
						Target: "/var/run/docker.sock",
						ReadOnly: true,
					},
					{
						Type: "bind",
						Source: "/sys",
						Target: "/host/sys",
						ReadOnly: true,
					},
					{
						Type: "bind",
						Source: "/etc/os-release",
						Target: "/etc/os-release",
						ReadOnly: true,
					},
					{
						Type: "bind",
						Source: "/proc",
						Target: "/host/proc",
						ReadOnly: true,
					},
					{
						Type: "bind",
						Source: "/etc/dokploy/monitoring/monitoring.db",
						Target: "/app/monitoring.db",
					},
				],
			},
			Networks: [{ Target: "host" }],
			Placement: {
				Constraints: ["node.role==manager"],
			},
		},
		Mode: {
			Replicated: {
				Replicas: 1,
			},
		},
	};

	const docker = await getRemoteDocker(serverId);

	await execAsyncRemote(
		serverId,
		"mkdir -p /etc/dokploy/monitoring && touch /etc/dokploy/monitoring/monitoring.db",
	);
	await withHostBuildAdmission(
		{ serverId, operation: "remote-monitoring-setup" },
		async (context) => {
			await pullImageUnderBuildAdmission({
				context,
				dockerImage: imageName,
				serverId,
			});
			await deployMonitoringService(docker, serviceName, settings, context);
		},
	);
};

export const setupWebMonitoring = async () => {
	const webServerSettings = await getWebServerSettings();

	const serviceName = "dokploy-monitoring";
	const imageName = getMonitoringImage();
	const port = webServerSettings?.metricsConfig?.server?.port;

	const settings: CreateServiceOptions = {
		Name: serviceName,
		TaskTemplate: {
			ContainerSpec: {
				Image: imageName,
				Env: [
					`METRICS_CONFIG=${JSON.stringify(webServerSettings?.metricsConfig)}`,
				],
				Mounts: [
					{
						Type: "bind",
						Source: "/var/run/docker.sock",
						Target: "/var/run/docker.sock",
						ReadOnly: true,
					},
					{
						Type: "bind",
						Source: "/sys",
						Target: "/host/sys",
						ReadOnly: true,
					},
					{
						Type: "bind",
						Source: "/etc/os-release",
						Target: "/etc/os-release",
						ReadOnly: true,
					},
					{
						Type: "bind",
						Source: "/proc",
						Target: "/host/proc",
						ReadOnly: true,
					},
					{
						Type: "bind",
						Source: "/etc/dokploy/monitoring/monitoring.db",
						Target: "/app/monitoring.db",
					},
				],
			},
			Placement: {
				Constraints: ["node.role==manager"],
			},
		},
		Mode: {
			Replicated: {
				Replicas: 1,
			},
		},
		EndpointSpec: {
			Ports: [
				{
					TargetPort: port,
					PublishedPort: port,
					Protocol: "tcp",
					PublishMode: "host",
				},
			],
		},
	};

	const docker = await getRemoteDocker();

	await execAsync(
		"mkdir -p /etc/dokploy/monitoring && touch /etc/dokploy/monitoring/monitoring.db",
	);
	await withHostBuildAdmission(
		{ serverId: null, operation: "web-monitoring-setup" },
		async (context) => {
			await pullImageUnderBuildAdmission({
				context,
				dockerImage: imageName,
				serverId: null,
			});
			await deployMonitoringService(docker, serviceName, settings, context);
		},
	);
};
