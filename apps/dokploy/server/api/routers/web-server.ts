import {
	checkPortInUse,
	findServerById,
	getWebServerPaths,
	IS_CLOUD,
	prepareEnvironmentVariables,
	readConfig,
	readConfigInPath,
	readDirectory,
	readEnvironmentVariables,
	readMainConfig,
	readPorts,
	reloadDockerResource,
	resolveWebServerProvider,
	writeConfig,
	writeMainConfig,
	writeTraefikConfigInPath,
	writeTraefikSetup,
} from "@dokploy/server";
import { checkPermission } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	apiEnableDashboard,
	apiModifyTraefikConfig,
	apiReadTraefikConfig,
	apiServerSchema,
	apiTraefikConfig,
} from "@/server/db/schema";
import { adminProcedure, createTRPCRouter, protectedProcedure } from "../trpc";

/**
 * Web-server (edge proxy) management endpoints, extracted from the settings
 * router. Traefik is currently the only provider; provider-specific
 * procedure names are kept so this stays a pure move (see
 * `@dokploy/server/utils/web-server/providers` for the provider seam).
 */
export const webServerRouter = createTRPCRouter({
	reloadTraefik: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			// Run in background so the request returns immediately; avoids proxy timeouts.
			void reloadDockerResource("dokploy-traefik", input?.serverId).catch(
				(err) => {
					console.error("reloadTraefik background:", err);
				},
			);
			await audit(ctx, {
				action: "reload",
				resourceType: "settings",
				resourceName: "dokploy-traefik",
			});
			return true;
		}),
	toggleDashboard: adminProcedure
		.input(apiEnableDashboard)
		.mutation(async ({ input, ctx }) => {
			const ports = await readPorts("dokploy-traefik", input.serverId);
			const env = await readEnvironmentVariables(
				"dokploy-traefik",
				input.serverId,
			);
			const preparedEnv = prepareEnvironmentVariables(env);
			let newPorts = ports;
			// If receive true, add 8080 to ports
			if (input.enableDashboard) {
				// Check if port 8080 is already in use before enabling dashboard
				const portCheck = await checkPortInUse(8080, input.serverId);
				if (portCheck.isInUse) {
					const conflictInfo = portCheck.conflictingContainer
						? ` by ${portCheck.conflictingContainer}`
						: "";
					throw new TRPCError({
						code: "CONFLICT",
						message: `Port 8080 is already in use${conflictInfo}. Please stop the conflicting service or use a different port for the Traefik dashboard.`,
					});
				}
				newPorts.push({
					targetPort: 8080,
					publishedPort: 8080,
					protocol: "tcp",
				});
			} else {
				newPorts = ports.filter((port) => port.targetPort !== 8080);
			}

			// Run in background so the request returns immediately; client polls /api/health.
			// Avoids proxy timeouts (520) while Traefik is recreated.
			void writeTraefikSetup({
				env: preparedEnv,
				additionalPorts: newPorts,
				serverId: input.serverId,
			}).catch((err) => {
				console.error("toggleDashboard background writeTraefikSetup:", err);
			});
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "toggle-dashboard",
			});
			return true;
		}),
	readTraefikConfig: adminProcedure.query(() => {
		if (IS_CLOUD) {
			return true;
		}
		const traefikConfig = readMainConfig();
		return traefikConfig;
	}),
	updateTraefikConfig: adminProcedure
		.input(apiTraefikConfig)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			writeMainConfig(input.traefikConfig);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "traefik-config",
			});
			return true;
		}),
	readWebServerTraefikConfig: adminProcedure.query(() => {
		if (IS_CLOUD) {
			return true;
		}
		const traefikConfig = readConfig("dokploy");
		return traefikConfig;
	}),
	updateWebServerTraefikConfig: adminProcedure
		.input(apiTraefikConfig)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			writeConfig("dokploy", input.traefikConfig);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "web-server-traefik-config",
			});
			return true;
		}),
	readMiddlewareTraefikConfig: adminProcedure.query(() => {
		if (IS_CLOUD) {
			return true;
		}
		const traefikConfig = readConfig("middlewares");
		return traefikConfig;
	}),
	updateMiddlewareTraefikConfig: adminProcedure
		.input(apiTraefikConfig)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			writeConfig("middlewares", input.traefikConfig);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "middleware-traefik-config",
			});
			return true;
		}),
	readDirectories: protectedProcedure
		.input(apiServerSchema)
		.query(async ({ ctx, input }) => {
			try {
				await checkPermission(ctx, { traefikFiles: ["read"] });
				const provider = await resolveWebServerProvider(input?.serverId);
				const { basePath } = getWebServerPaths(provider, !!input?.serverId);
				const result = await readDirectory(basePath, input?.serverId);
				return result || [];
			} catch (error) {
				throw error;
			}
		}),
	updateTraefikFile: protectedProcedure
		.input(apiModifyTraefikConfig)
		.mutation(async ({ input, ctx }) => {
			await checkPermission(ctx, { traefikFiles: ["write"] });
			await writeTraefikConfigInPath(
				input.path,
				input.traefikConfig,
				input?.serverId,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "traefik-file",
			});
			return true;
		}),
	readTraefikFile: protectedProcedure
		.input(apiReadTraefikConfig)
		.query(async ({ input, ctx }) => {
			await checkPermission(ctx, { traefikFiles: ["read"] });

			if (input.serverId) {
				const server = await findServerById(input.serverId);

				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({ code: "UNAUTHORIZED" });
				}
			}

			return readConfigInPath(input.path, input.serverId);
		}),
	readTraefikEnv: adminProcedure
		.input(apiServerSchema)
		.query(async ({ input }) => {
			const envVars = await readEnvironmentVariables(
				"dokploy-traefik",
				input?.serverId,
			);
			return envVars;
		}),
	writeTraefikEnv: adminProcedure
		.input(z.object({ env: z.string(), serverId: z.string().optional() }))
		.mutation(async ({ input, ctx }) => {
			const envs = prepareEnvironmentVariables(input.env);
			const ports = await readPorts("dokploy-traefik", input?.serverId);

			// Run in background so the request returns immediately; client polls /api/health.
			void writeTraefikSetup({
				env: envs,
				additionalPorts: ports,
				serverId: input.serverId,
			}).catch((err) => {
				console.error("writeTraefikEnv background writeTraefikSetup:", err);
			});
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "traefik-env",
			});
			return true;
		}),
	haveTraefikDashboardPortEnabled: adminProcedure
		.input(apiServerSchema)
		.query(async ({ input }) => {
			const ports = await readPorts("dokploy-traefik", input?.serverId);
			return ports.some((port) => port.targetPort === 8080);
		}),
	updateTraefikPorts: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
				additionalPorts: z.array(
					z.object({
						targetPort: z.number(),
						publishedPort: z.number(),
						protocol: z.enum(["tcp", "udp", "sctp"]),
					}),
				),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			try {
				if (IS_CLOUD && !input.serverId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "Please set a serverId to update Traefik ports",
					});
				}
				const env = await readEnvironmentVariables(
					"dokploy-traefik",
					input?.serverId,
				);

				for (const port of input.additionalPorts) {
					const portCheck = await checkPortInUse(
						port.publishedPort,
						input.serverId,
					);
					if (portCheck.isInUse) {
						throw new TRPCError({
							code: "CONFLICT",
							message: `Port ${port.targetPort} is already in use by ${portCheck.conflictingContainer}`,
						});
					}
				}
				const preparedEnv = prepareEnvironmentVariables(env);

				// Run in background so the request returns immediately; client polls /api/health.
				void writeTraefikSetup({
					env: preparedEnv,
					additionalPorts: input.additionalPorts,
					serverId: input.serverId,
				}).catch((err) => {
					console.error(
						"updateTraefikPorts background writeTraefikSetup:",
						err,
					);
				});
				await audit(ctx, {
					action: "update",
					resourceType: "settings",
					resourceName: "traefik-ports",
				});
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? error.message
							: "Error updating Traefik ports",
					cause: error,
				});
			}
		}),
	getTraefikPorts: adminProcedure
		.input(apiServerSchema)
		.query(async ({ input }) => {
			const ports = await readPorts("dokploy-traefik", input?.serverId);
			return ports;
		}),
	haveActivateRequests: protectedProcedure.query(async () => {
		if (IS_CLOUD) {
			return true;
		}
		const config = readMainConfig();

		if (!config) return false;
		const parsedConfig = parse(config) as {
			accessLog?: {
				filePath: string;
			};
		};

		return !!parsedConfig?.accessLog?.filePath;
	}),
	toggleRequests: protectedProcedure
		.input(
			z.object({
				enable: z.boolean(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			const mainConfig = readMainConfig();
			if (!mainConfig) return false;

			const currentConfig = parse(mainConfig) as {
				accessLog?: {
					filePath: string;
				};
			};

			if (input.enable) {
				const config = {
					accessLog: {
						filePath: "/etc/dokploy/traefik/dynamic/access.log",
						format: "json",
						bufferingSize: 100,
					},
				};
				currentConfig.accessLog = config.accessLog;
			} else {
				currentConfig.accessLog = undefined;
			}

			writeMainConfig(stringify(currentConfig));
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "toggle-requests",
			});
			return true;
		}),
});
