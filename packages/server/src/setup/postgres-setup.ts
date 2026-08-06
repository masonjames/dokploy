import type { CreateServiceOptions } from "dockerode";
import { docker } from "../constants";
import { pullImageUnderBuildAdmission } from "../utils/docker/utils";
import { withHostBuildAdmission } from "../utils/process/build-admission";
export const initializePostgres = async () => {
	const imageName = "postgres:16";
	const containerName = "dokploy-postgres";
	const settings: CreateServiceOptions = {
		Name: containerName,
		TaskTemplate: {
			ContainerSpec: {
				Image: imageName,
				Env: [
					"POSTGRES_USER=dokploy",
					"POSTGRES_DB=dokploy",
					"POSTGRES_PASSWORD=amukds4wi9001583845717ad2",
				],
				Mounts: [
					{
						Type: "volume",
						Source: "dokploy-postgres",
						Target: "/var/lib/postgresql/data",
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
						TargetPort: 5432,
						PublishedPort: 5432,
						Protocol: "tcp",
						PublishMode: "host",
					},
				],
			},
		}),
	};
	await withHostBuildAdmission(
		{ serverId: null, operation: "dokploy-postgres-initialize" },
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
					console.log("Postgres service already exists, continuing...");
				}
				console.log("Postgres Not Found: Starting ✅");
				return;
			}

			context.assertLockHeld();
			await service.update({
				version: Number.parseInt(inspect.Version.Index),
				...settings,
			});
			context.assertLockHeld();
			console.log("Postgres Started ✅");
		},
	);
};
