import type { CreateServiceOptions } from "dockerode";
import { docker } from "../constants";
import { pullImageUnderBuildAdmission } from "../utils/docker/utils";
import { withHostBuildAdmission } from "../utils/process/build-admission";

export const initializeRedis = async () => {
	const imageName = "redis:8";
	const containerName = "dokploy-redis";

	const settings: CreateServiceOptions = {
		Name: containerName,
		TaskTemplate: {
			ContainerSpec: {
				Image: imageName,
				Mounts: [
					{
						Type: "volume",
						Source: "dokploy-redis",
						Target: "/data",
					},
				],
			},
			Networks: [{ Target: "dokploy-network" }],
			Placement: {
				Constraints: ["node.role==manager"],
			},
		},
		Mode: {
			Replicated: {
				Replicas: 1,
			},
		},
		...(process.env.NODE_ENV === "development" && {
			EndpointSpec: {
				Ports: [
					{
						TargetPort: 6379,
						PublishedPort: 6379,
						Protocol: "tcp",
						PublishMode: "host",
					},
				],
			},
		}),
	};
	await withHostBuildAdmission(
		{ serverId: null, operation: "dokploy-redis-initialize" },
		async (context) => {
			await pullImageUnderBuildAdmission({
				context,
				dockerImage: imageName,
				serverId: null,
			});
			const service = docker.getService(containerName);
			let inspect: Awaited<ReturnType<typeof service.inspect>>;
			try {
				inspect = await service.inspect();
			} catch {
				context.assertLockHeld();
				try {
					await docker.createService(settings);
					context.assertLockHeld();
				} catch (error: any) {
					if (error?.statusCode !== 409) {
						throw error;
					}
					console.log("Redis service already exists, continuing...");
				}
				console.log("Redis Not Found: Starting ✅");
				return;
			}

			context.assertLockHeld();
			await service.update({
				version: Number.parseInt(inspect.Version.Index),
				...settings,
			});
			context.assertLockHeld();
			console.log("Redis Started ✅");
		},
	);
};
