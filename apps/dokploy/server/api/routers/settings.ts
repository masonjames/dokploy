import {
	CLEANUP_CRON_JOB,
	checkGPUStatus,
	checkPostgresHealth,
	checkRedisHealth,
	checkWebServerHealth,
	cleanupAll,
	cleanupAllBackground,
	cleanupBuilders,
	cleanupContainers,
	cleanupImages,
	cleanupSystem,
	cleanupVolumes,
	DEFAULT_UPDATE_DATA,
	execAsync,
	findServerById,
	getDockerDiskUsage,
	getDokployImageTag,
	getLogCleanupStatus,
	getUpdateData,
	getWebServerSettings,
	IS_CLOUD,
	parseRawConfig,
	paths,
	processLogs,
	readMonitoringConfig,
	recreateDirectory,
	reloadDockerResource,
	resolveWebServerProvider,
	sendDockerCleanupNotifications,
	setupGPUSupport,
	spawnAsync,
	startLogCleanup,
	stopLogCleanup,
	updateLetsEncryptEmail,
	updateServerById,
	updateServerTraefik,
	updateWebServerSettings,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { generateOpenApiDocument } from "@dokploy/trpc-openapi";
import { TRPCError } from "@trpc/server";
import { eq, sql } from "drizzle-orm";
import { scheduledJobs, scheduleJob } from "node-schedule";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	apiAssignDomain,
	apiReadStatsLogs,
	apiSaveSSHKey,
	apiServerSchema,
	apiUpdateDockerCleanup,
	projects,
	server,
} from "@/server/db/schema";
import { cleanAllDeploymentQueue } from "@/server/queues/queueSetup";
import { removeJob, schedule } from "@/server/utils/backup";
import packageInfo from "../../../package.json";
import { appRouter } from "../root";
import {
	adminProcedure,
	createTRPCRouter,
	enterpriseProcedure,
	protectedProcedure,
	publicProcedure,
} from "../trpc";

export const settingsRouter = createTRPCRouter({
	getWebServerSettings: protectedProcedure.query(async () => {
		if (IS_CLOUD) {
			return null;
		}
		const settings = await getWebServerSettings();
		return settings;
	}),
	reloadServer: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}
		await reloadDockerResource("dokploy", undefined, packageInfo.version);
		await audit(ctx, {
			action: "reload",
			resourceType: "settings",
			resourceName: "dokploy",
		});
		return true;
	}),
	cleanRedis: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}

		const { stdout: containerId } = await execAsync(
			`docker ps --filter "name=dokploy-redis" --filter "status=running" -q | head -n 1`,
		);

		if (!containerId) {
			throw new Error("Redis container not found");
		}

		const redisContainerId = containerId.trim();

		await execAsync(`docker exec -i ${redisContainerId} redis-cli flushall`);
		await audit(ctx, {
			action: "update",
			resourceType: "settings",
			resourceName: "clean-redis",
		});
		return true;
	}),
	reloadRedis: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}
		await reloadDockerResource("dokploy-redis");
		await audit(ctx, {
			action: "reload",
			resourceType: "settings",
			resourceName: "dokploy-redis",
		});
		return true;
	}),
	cleanAllDeploymentQueue: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}
		const result = cleanAllDeploymentQueue();
		await audit(ctx, {
			action: "update",
			resourceType: "settings",
			resourceName: "clean-deployment-queue",
		});
		return result;
	}),
	cleanUnusedImages: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await cleanupImages(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-unused-images",
			});
			return true;
		}),
	cleanUnusedVolumes: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await cleanupVolumes(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-unused-volumes",
			});
			return true;
		}),
	cleanStoppedContainers: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await cleanupContainers(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-stopped-containers",
			});
			return true;
		}),
	cleanDockerBuilder: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await cleanupBuilders(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-docker-builder",
			});
		}),
	cleanDockerPrune: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await cleanupSystem(input?.serverId);
			await cleanupBuilders(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-docker-prune",
			});
			return true;
		}),
	cleanAll: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			// Execute cleanup in background and return immediately to avoid gateway timeouts
			const result = await cleanupAllBackground(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-all",
			});
			return result;
		}),
	cleanMonitoring: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}
		const { MONITORING_PATH } = paths();
		await recreateDirectory(MONITORING_PATH);
		await audit(ctx, {
			action: "delete",
			resourceType: "settings",
			resourceName: "clean-monitoring",
		});
		return true;
	}),
	getDockerDiskUsage: adminProcedure.query(async () => {
		if (IS_CLOUD) {
			return [];
		}
		return getDockerDiskUsage();
	}),
	saveSSHPrivateKey: adminProcedure
		.input(apiSaveSSHKey)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			await updateWebServerSettings({
				sshPrivateKey: input.sshPrivateKey,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "ssh-private-key",
			});
			return true;
		}),
	assignDomainServer: adminProcedure
		.input(apiAssignDomain)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			const settings = await updateWebServerSettings({
				host: input.host,
				letsEncryptEmail: input.letsEncryptEmail,
				certificateType: input.certificateType,
				https: input.https,
			});

			if (!settings) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Web server settings not found",
				});
			}

			updateServerTraefik(settings, input.host);
			if (input.letsEncryptEmail) {
				updateLetsEncryptEmail(input.letsEncryptEmail);
			}

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "assign-domain-server",
			});
			return settings;
		}),
	cleanSSHPrivateKey: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}
		await updateWebServerSettings({
			sshPrivateKey: null,
		});
		await audit(ctx, {
			action: "delete",
			resourceType: "settings",
			resourceName: "ssh-private-key",
		});
		return true;
	}),
	updateDockerCleanup: adminProcedure
		.input(apiUpdateDockerCleanup)
		.mutation(async ({ input, ctx }) => {
			if (input.serverId) {
				await updateServerById(input.serverId, {
					enableDockerCleanup: input.enableDockerCleanup,
				});

				const server = await findServerById(input.serverId);

				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this server",
					});
				}

				if (server.enableDockerCleanup) {
					const server = await findServerById(input.serverId);
					if (server.serverStatus === "inactive") {
						throw new TRPCError({
							code: "NOT_FOUND",
							message: "Server is inactive",
						});
					}
					if (IS_CLOUD) {
						await schedule({
							cronSchedule: CLEANUP_CRON_JOB,
							serverId: input.serverId,
							type: "server",
						});
					} else {
						scheduleJob(server.serverId, CLEANUP_CRON_JOB, async () => {
							console.log(
								`Docker Cleanup ${new Date().toLocaleString()}] Running...`,
							);

							await cleanupAll(server.serverId);

							await sendDockerCleanupNotifications(server.organizationId);
						});
					}
				} else {
					if (IS_CLOUD) {
						await removeJob({
							cronSchedule: CLEANUP_CRON_JOB,
							serverId: input.serverId,
							type: "server",
						});
					} else {
						const currentJob = scheduledJobs[server.serverId];
						currentJob?.cancel();
					}
				}
			} else if (!IS_CLOUD) {
				const settingsUpdated = await updateWebServerSettings({
					enableDockerCleanup: input.enableDockerCleanup,
				});

				if (settingsUpdated?.enableDockerCleanup) {
					scheduleJob("docker-cleanup", CLEANUP_CRON_JOB, async () => {
						console.log(
							`Docker Cleanup ${new Date().toLocaleString()}] Running...`,
						);

						await cleanupAll();

						await sendDockerCleanupNotifications(
							ctx.session.activeOrganizationId,
						);
					});
				} else {
					const currentJob = scheduledJobs["docker-cleanup"];
					currentJob?.cancel();
				}
			}

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "docker-cleanup",
			});
			return true;
		}),

	updateRemoteServersOnly: enterpriseProcedure
		.input(z.object({ remoteServersOnly: z.boolean() }))
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This feature is only available for self-hosted instances",
				});
			}

			await updateWebServerSettings({
				remoteServersOnly: input.remoteServersOnly,
			});

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "remote-servers-only",
			});
			return true;
		}),

	updateEnforceSSO: enterpriseProcedure
		.input(z.object({ enforceSSO: z.boolean() }))
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This feature is only available for self-hosted instances",
				});
			}

			await updateWebServerSettings({
				enforceSSO: input.enforceSSO,
			});

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "enforce-sso",
			});
			return true;
		}),

	getUpdateData: protectedProcedure.mutation(async () => {
		if (IS_CLOUD) {
			return DEFAULT_UPDATE_DATA;
		}

		return await getUpdateData(packageInfo.version);
	}),
	updateServer: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}

		const data = await getUpdateData(packageInfo.version);
		if (data.updateAvailable) {
			void spawnAsync("docker", [
				"service",
				"update",
				"--force",
				"--image",
				`dokploy/dokploy:${data.latestVersion}`,
				"dokploy",
			]);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "dokploy-version",
			});
		}

		return true;
	}),

	getDokployVersion: protectedProcedure.query(() => {
		return packageInfo.version;
	}),
	getReleaseTag: protectedProcedure.query(() => {
		return getDokployImageTag();
	}),
	getIp: protectedProcedure.query(async () => {
		if (IS_CLOUD) {
			return "";
		}
		const settings = await getWebServerSettings();
		return settings?.serverIp || "";
	}),
	updateServerIp: adminProcedure
		.input(
			z.object({
				serverIp: z.string(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			const settings = await updateWebServerSettings({
				serverIp: input.serverIp,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "server-ip",
			});
			return settings;
		}),

	getOpenApiDocument: protectedProcedure.query(
		async ({ ctx }): Promise<unknown> => {
			const protocol = ctx.req.headers["x-forwarded-proto"];
			const url = `${protocol}://${ctx.req.headers.host}/api`;
			const openApiDocument = generateOpenApiDocument(appRouter, {
				title: "tRPC OpenAPI",
				version: packageInfo.version,
				baseUrl: url,
				docsUrl: `${url}/settings.getOpenApiDocument`,
				tags: [
					"admin",
					"docker",
					"compose",
					"registry",
					"cluster",
					"user",
					"domain",
					"destination",
					"backup",
					"deployment",
					"mounts",
					"certificates",
					"settings",
					"security",
					"redirects",
					"port",
					"project",
					"application",
					"mysql",
					"postgres",
					"redis",
					"mongo",
					"libsql",
					"mariadb",
					"sshRouter",
					"gitProvider",
					"bitbucket",
					"ai",
					"github",
					"gitlab",
					"gitea",
					"tag",
					"patch",
					"server",
					"volumeBackups",
					"environment",
					"auditLog",
					"customRole",
					"whitelabeling",
					"sso",
					"licenseKey",
					"organization",
					"previewDeployment",
				],
			});

			openApiDocument.info = {
				title: "Dokploy API",
				description: "Endpoints for dokploy",
				version: packageInfo.version,
			};

			// Add security schemes configuration
			openApiDocument.components = {
				...openApiDocument.components,
				securitySchemes: {
					apiKey: {
						type: "apiKey",
						in: "header",
						name: "x-api-key",
						description: "API key authentication",
					},
				},
			};

			// Apply security globally to all endpoints
			openApiDocument.security = [
				{
					apiKey: [],
				},
			];
			return openApiDocument;
		},
	),
	readStatsLogs: protectedProcedure
		.meta({
			openapi: {
				path: "/read-stats-logs",
				method: "POST",
				override: true,
				enabled: false,
			},
		})
		.input(apiReadStatsLogs)
		.query(async ({ input }) => {
			if (IS_CLOUD) {
				return {
					data: [],
					totalCount: 0,
				};
			}
			const rawConfig = await readMonitoringConfig(
				!!input.dateRange?.start && !!input.dateRange?.end,
			);

			const parsedConfig = parseRawConfig(
				rawConfig as string,
				input.page,
				input.sort,
				input.search,
				input.status,
				input.dateRange,
			);

			return parsedConfig;
		}),
	readStats: adminProcedure
		.meta({
			openapi: {
				path: "/read-stats",
				method: "POST",
				override: true,
				enabled: false,
			},
		})
		.input(
			z
				.object({
					dateRange: z
						.object({
							start: z.string().optional(),
							end: z.string().optional(),
						})
						.optional(),
				})
				.optional(),
		)
		.query(async ({ input }) => {
			if (IS_CLOUD) {
				return [];
			}
			const rawConfig = await readMonitoringConfig(
				!!input?.dateRange?.start || !!input?.dateRange?.end,
			);
			const processedLogs = processLogs(rawConfig as string, input?.dateRange);
			return processedLogs || [];
		}),
	isCloud: publicProcedure.query(async () => {
		return IS_CLOUD;
	}),
	isUserSubscribed: protectedProcedure.query(async ({ ctx }) => {
		const haveServers = await db.query.server.findMany({
			where: eq(server.organizationId, ctx.session?.activeOrganizationId || ""),
		});
		const haveProjects = await db.query.projects.findMany({
			where: eq(
				projects.organizationId,
				ctx.session?.activeOrganizationId || "",
			),
		});
		return haveServers.length > 0 || haveProjects.length > 0;
	}),
	health: publicProcedure.query(async () => {
		try {
			await db.execute(sql`SELECT 1`);
			return { status: "ok" };
		} catch (error) {
			console.error("Database connection error:", error);
			throw error;
		}
	}),
	checkInfrastructureHealth: adminProcedure.query(async () => {
		const provider = await resolveWebServerProvider();
		if (IS_CLOUD) {
			const webServer = { provider, status: "healthy" as const };
			return {
				postgres: { status: "healthy" as const },
				redis: { status: "healthy" as const },
				webServer,
				traefik: { status: webServer.status },
			};
		}

		const [postgres, redis, webServer] = await Promise.all([
			checkPostgresHealth(),
			checkRedisHealth(),
			checkWebServerHealth(provider),
		]);

		return {
			postgres,
			redis,
			webServer,
			// Kept for backward compatibility with consumers of the old shape.
			traefik: { status: webServer.status, message: webServer.message },
		};
	}),
	setupGPU: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD && !input.serverId) {
				throw new Error("Select a server to enable the GPU Setup");
			}

			try {
				await setupGPUSupport(input.serverId);
				await audit(ctx, {
					action: "update",
					resourceType: "settings",
					resourceName: "setup-gpu",
				});
				return { success: true };
			} catch (error) {
				console.error("GPU Setup Error:", error);
				throw error;
			}
		}),
	checkGPUStatus: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input }) => {
			if (IS_CLOUD && !input.serverId) {
				return {
					driverInstalled: false,
					driverVersion: undefined,
					gpuModel: undefined,
					runtimeInstalled: false,
					runtimeConfigured: false,
					cudaSupport: undefined,
					cudaVersion: undefined,
					memoryInfo: undefined,
					availableGPUs: 0,
					swarmEnabled: false,
					gpuResources: 0,
				};
			}

			try {
				return await checkGPUStatus(input.serverId || "");
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Failed to check GPU status";
				throw new TRPCError({
					code: "BAD_REQUEST",
					message,
				});
			}
		}),
	updateLogCleanup: protectedProcedure
		.input(
			z.object({
				cronExpression: z.string().nullable(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			let result: boolean;
			if (input.cronExpression) {
				result = await startLogCleanup(input.cronExpression);
			} else {
				result = await stopLogCleanup();
			}
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "log-cleanup",
			});
			return result;
		}),

	getLogCleanupStatus: protectedProcedure.query(async () => {
		return getLogCleanupStatus();
	}),

	getDokployCloudIps: adminProcedure.query(async () => {
		if (!IS_CLOUD) {
			return [];
		}
		const ips = process.env.DOKPLOY_CLOUD_IPS?.split(",");
		return ips;
	}),
});
