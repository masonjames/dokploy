import { join } from "node:path";
import { paths } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	type apiCreateCompose,
	buildAppName,
	cleanAppName,
	compose,
} from "@dokploy/server/db/schema";
import { getBuildComposeCommand } from "@dokploy/server/utils/builders/compose";
import { randomizeSpecificationFile } from "@dokploy/server/utils/docker/compose";
import {
	cloneCompose,
	getCaddyComposeRouteTargetsForWebServer,
	loadDockerCompose,
	loadDockerComposeRemote,
	writeCaddyComposeRoutesForTargets,
} from "@dokploy/server/utils/docker/domain";
import {
	buildStackCleanupCommand,
	parseStackCleanupOutput,
	StackCleanupError,
	type StackCleanupReport,
} from "@dokploy/server/utils/docker/stack-cleanup";
import type { ComposeSpecification } from "@dokploy/server/utils/docker/types";
import { sendBuildErrorNotifications } from "@dokploy/server/utils/notifications/build-error";
import { sendBuildSuccessNotifications } from "@dokploy/server/utils/notifications/build-success";
import { withHostBuildAdmission } from "@dokploy/server/utils/process/build-admission";
import {
	ExecError,
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { cloneBitbucketRepository } from "@dokploy/server/utils/providers/bitbucket";
import {
	cloneGitRepository,
	getGitCommitInfo,
} from "@dokploy/server/utils/providers/git";
import { cloneGiteaRepository } from "@dokploy/server/utils/providers/gitea";
import { cloneGithubRepository } from "@dokploy/server/utils/providers/github";
import { cloneGitlabRepository } from "@dokploy/server/utils/providers/gitlab";
import { getCreateComposeFileCommand } from "@dokploy/server/utils/providers/raw";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { quote } from "shell-quote";
import type { z } from "zod";
import { encodeBase64 } from "../utils/docker/utils";
import { getDokployUrl } from "./admin";
import {
	createDeploymentCompose,
	updateDeployment,
	updateDeploymentStatus,
} from "./deployment";
import { generateApplyPatchesCommand } from "./patch";
import { validUniqueServerAppName } from "./project";

export type Compose = typeof compose.$inferSelect;

export type ComposeCleanupReport =
	| StackCleanupReport
	| {
			kind: "docker-compose";
			projectName: string;
			deleteVolumes: boolean;
			verified: true;
	  };

export const createCompose = async (
	input: z.infer<typeof apiCreateCompose>,
) => {
	const appName = buildAppName("compose", input.appName);

	const valid = await validUniqueServerAppName(appName);
	if (!valid) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Service with this 'AppName' already exists",
		});
	}

	const newDestination = await db
		.insert(compose)
		.values({
			...input,
			composeFile: input.composeFile || "",
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newDestination) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting compose",
		});
	}

	return newDestination;
};

export const createComposeByTemplate = async (
	input: typeof compose.$inferInsert,
) => {
	const appName = cleanAppName(input.appName);
	if (appName) {
		const valid = await validUniqueServerAppName(appName);

		if (!valid) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Service with this 'AppName' already exists",
			});
		}
	}
	const newDestination = await db
		.insert(compose)
		.values({
			...input,
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newDestination) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting compose",
		});
	}

	return newDestination;
};

export const findComposeById = async (composeId: string) => {
	const result = await db.query.compose.findFirst({
		where: eq(compose.composeId, composeId),
		with: {
			environment: {
				with: {
					project: true,
				},
			},
			deployments: true,
			mounts: true,
			domains: true,
			github: true,
			gitlab: true,
			bitbucket: true,
			gitea: true,
			server: true,
			backups: {
				with: {
					destination: {
						columns: {
							accessKey: false,
							secretAccessKey: false,
						},
					},
					deployments: true,
				},
			},
		},
	});
	if (!result) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Compose not found",
		});
	}
	return result;
};

export const loadServices = async (
	composeId: string,
	type: "fetch" | "cache" = "fetch",
) => {
	const compose = await findComposeById(composeId);

	if (type === "fetch") {
		const command = await cloneCompose(compose);
		await withHostBuildAdmission(
			{ serverId: compose.serverId, operation: "compose-service-fetch" },
			async ({ prepareCommand, signal }) => {
				const admittedCommand = await prepareCommand(command);
				if (compose.serverId) {
					await execAsyncRemote(
						compose.serverId,
						admittedCommand,
						undefined,
						signal,
					);
				} else {
					await execAsync(admittedCommand, { signal });
				}
			},
		);
	}

	let composeData: ComposeSpecification | null;

	if (compose.serverId) {
		composeData = await loadDockerComposeRemote(compose);
	} else {
		composeData = await loadDockerCompose(compose);
	}

	if (compose.randomize && composeData) {
		const randomizedCompose = randomizeSpecificationFile(
			composeData,
			compose.suffix,
		);
		composeData = randomizedCompose;
	}

	if (!composeData?.services) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Services not found",
		});
	}

	const services = Object.keys(composeData.services);

	return [...services];
};

export const updateCompose = async (
	composeId: string,
	composeData: Partial<Compose>,
) => {
	const { appName, ...rest } = composeData;
	const composeResult = await db
		.update(compose)
		.set({
			...rest,
		})
		.where(eq(compose.composeId, composeId))
		.returning();

	return composeResult[0];
};

export const deployCompose = async ({
	composeId,
	titleLog = "Manual deployment",
	descriptionLog = "",
}: {
	composeId: string;
	titleLog: string;
	descriptionLog: string;
}) => {
	const compose = await findComposeById(composeId);

	const buildLink = `${await getDokployUrl()}/dashboard/project/${
		compose.environment.projectId
	}/environment/${compose.environmentId}/services/compose/${compose.composeId}?tab=deployments`;
	const deployment = await createDeploymentCompose({
		composeId: composeId,
		title: titleLog,
		description: descriptionLog,
	});

	try {
		const entity = {
			...compose,
			type: "compose" as const,
		};
		let caddyComposeRouteTargets: Awaited<
			ReturnType<typeof getCaddyComposeRouteTargetsForWebServer>
		> = null;
		await withHostBuildAdmission(
			{ serverId: compose.serverId, operation: "compose-deploy" },
			async ({ prepareCommand, signal }) => {
				const execute = async (commandToExecute: string) => {
					const admittedCommand = await prepareCommand(commandToExecute);
					if (compose.serverId) {
						await execAsyncRemote(
							compose.serverId,
							admittedCommand,
							undefined,
							signal,
						);
					} else {
						await execAsync(admittedCommand, { signal });
					}
				};

				let command = "set -e;";
				if (compose.sourceType === "github") {
					command += await cloneGithubRepository(entity);
				} else if (compose.sourceType === "gitlab") {
					command += await cloneGitlabRepository(entity);
				} else if (compose.sourceType === "bitbucket") {
					command += await cloneBitbucketRepository(entity);
				} else if (compose.sourceType === "git") {
					command += await cloneGitRepository(entity);
				} else if (compose.sourceType === "gitea") {
					command += await cloneGiteaRepository(entity);
				} else if (compose.sourceType === "raw") {
					command += getCreateComposeFileCommand(entity);
				}
				await execute(`(${command}) >> ${deployment.logPath} 2>&1`);

				if (compose.sourceType !== "raw") {
					command = "set -e;";
					command += await generateApplyPatchesCommand({
						id: compose.composeId,
						type: "compose",
						serverId: compose.serverId,
					});
					await execute(`(${command}) >> ${deployment.logPath} 2>&1`);
				}

				caddyComposeRouteTargets =
					await getCaddyComposeRouteTargetsForWebServer(
						entity,
						compose.domains,
					);

				command = "set -e;";
				command += await getBuildComposeCommand(entity);
				await execute(`(${command}) >> ${deployment.logPath} 2>&1`);
			},
		);

		if (caddyComposeRouteTargets) {
			await writeCaddyComposeRoutesForTargets(
				entity,
				caddyComposeRouteTargets,
				{
					organizationId: compose.environment.project.organizationId,
				},
			);
		}

		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateCompose(composeId, {
			composeStatus: "done",
		});

		await sendBuildSuccessNotifications({
			projectName: compose.environment.project.name,
			applicationName: compose.name,
			applicationType: "compose",
			buildLink,
			organizationId: compose.environment.project.organizationId,
			domains: compose.domains,
			environmentName: compose.environment.name,
		});
	} catch (error) {
		let command = "";

		// Only log details for non-ExecError errors
		if (!(error instanceof ExecError)) {
			const message = error instanceof Error ? error.message : String(error);
			const encodedMessage = encodeBase64(message);
			command += `echo "${encodedMessage}" | base64 -d >> "${deployment.logPath}";`;
		}

		command += `echo "\nError occurred ❌, check the logs for details." >> ${deployment.logPath};`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, command);
		} else {
			await execAsync(command);
		}
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		await sendBuildErrorNotifications({
			projectName: compose.environment.project.name,
			applicationName: compose.name,
			applicationType: "compose",
			// @ts-ignore
			errorMessage: error?.message || "Error building",
			buildLink,
			organizationId: compose.environment.project.organizationId,
		});
		throw error;
	} finally {
		if (compose.sourceType !== "raw") {
			const commitInfo = await getGitCommitInfo({
				...compose,
				type: "compose",
			});
			if (commitInfo) {
				await updateDeployment(deployment.deploymentId, {
					title: commitInfo.message,
					description: `Commit: ${commitInfo.hash}`,
				});
			}
		}
	}
};

export const rebuildCompose = async ({
	composeId,
	titleLog = "Rebuild deployment",
	descriptionLog = "",
}: {
	composeId: string;
	titleLog: string;
	descriptionLog: string;
}) => {
	const compose = await findComposeById(composeId);

	const deployment = await createDeploymentCompose({
		composeId: composeId,
		title: titleLog,
		description: descriptionLog,
	});

	try {
		let caddyComposeRouteTargets: Awaited<
			ReturnType<typeof getCaddyComposeRouteTargetsForWebServer>
		> = null;
		await withHostBuildAdmission(
			{ serverId: compose.serverId, operation: "compose-rebuild" },
			async ({ prepareCommand, signal }) => {
				const execute = async (commandToExecute: string) => {
					const admittedCommand = await prepareCommand(commandToExecute);
					if (compose.serverId) {
						await execAsyncRemote(
							compose.serverId,
							admittedCommand,
							undefined,
							signal,
						);
					} else {
						await execAsync(admittedCommand, { signal });
					}
				};

				let command = "set -e;";
				if (compose.sourceType === "raw") {
					command += getCreateComposeFileCommand(compose);
					await execute(`(${command}) >> ${deployment.logPath} 2>&1`);
				} else {
					command += await generateApplyPatchesCommand({
						id: compose.composeId,
						type: "compose",
						serverId: compose.serverId,
					});
					await execute(`(${command}) >> ${deployment.logPath} 2>&1`);
				}

				caddyComposeRouteTargets =
					await getCaddyComposeRouteTargetsForWebServer(
						compose,
						compose.domains,
					);

				command = "set -e;";
				command += await getBuildComposeCommand(compose);
				await execute(`(${command}) >> ${deployment.logPath} 2>&1`);
			},
		);

		if (caddyComposeRouteTargets) {
			await writeCaddyComposeRoutesForTargets(
				compose,
				caddyComposeRouteTargets,
				{
					organizationId: compose.environment.project.organizationId,
				},
			);
		}

		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateCompose(composeId, {
			composeStatus: "done",
		});
	} catch (error) {
		let command = "";

		// Only log details for non-ExecError errors
		if (!(error instanceof ExecError)) {
			const message = error instanceof Error ? error.message : String(error);
			const encodedMessage = encodeBase64(message);
			command += `echo "${encodedMessage}" | base64 -d >> "${deployment.logPath}";`;
		}

		command += `echo "\nError occurred ❌, check the logs for details." >> ${deployment.logPath};`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, command);
		} else {
			await execAsync(command);
		}
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		throw error;
	}

	return true;
};

export const removeCompose = async (
	compose: Compose,
	deleteVolumes: boolean,
): Promise<ComposeCleanupReport> => {
	try {
		const { COMPOSE_PATH } = paths(!!compose.serverId);
		const projectRoot = join(COMPOSE_PATH, compose.appName);
		const projectPath = join(projectRoot, "code");

		if (compose.composeType === "stack") {
			const command = buildStackCleanupCommand({
				stackName: compose.appName,
				deleteVolumes,
				isolatedDeployment: compose.isolatedDeployment,
			});

			let stdout: string;
			if (compose.serverId) {
				({ stdout } = await execAsyncRemote(compose.serverId, command));
			} else {
				({ stdout } = await execAsync(command));
			}

			const report = parseStackCleanupOutput({
				stackName: compose.appName,
				deleteVolumes,
				stdout,
			});
			if (!report.verified) {
				throw new Error(
					"Stack cleanup completed without verification evidence",
				);
			}
			return report;
		}
		const composePath =
			compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath;
		const isolatedNetworkCleanup = compose.isolatedDeployment
			? `
			if docker network inspect ${quote([compose.appName])} >/dev/null 2>&1; then
				_dokploy_attached_containers=$(docker network inspect --format '{{range .Containers}}{{.Name}} {{end}}' ${quote([compose.appName])})
				for _dokploy_container in $_dokploy_attached_containers; do
					docker network disconnect -f ${quote([compose.appName])} "$_dokploy_container" >/dev/null 2>&1 || true
				done
				docker network rm ${quote([compose.appName])}
			fi`
			: "";
		const command = `
				set -eu
				cd ${quote([projectPath])}
				env -i PATH="$PATH" docker compose -p ${quote([compose.appName])} -f ${quote([composePath])} down ${deleteVolumes ? "--volumes" : ""}
				${isolatedNetworkCleanup}
				rm -rf -- ${quote([projectRoot])}`;

		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, command);
		} else {
			await execAsync(command);
		}
		return {
			kind: "docker-compose",
			projectName: compose.appName,
			deleteVolumes,
			verified: true,
		};
	} catch (error) {
		if (error instanceof ExecError) {
			if (compose.composeType === "stack") {
				const report = parseStackCleanupOutput({
					stackName: compose.appName,
					deleteVolumes,
					stdout: error.stdout || "",
				});
				const residualGroups: Array<[string, string[]]> = [
					["services", report.residualServices],
					["containers", report.residualContainers],
					["networks", report.residualNetworks],
					["volumes", report.residualVolumes],
				];
				const residuals = residualGroups
					.filter(([, ids]) => ids.length > 0)
					.map(([kind, ids]) => `${kind}=${ids.join(",")}`)
					.join("; ");
				const detail = [error.stderr, residuals, error.stdout]
					.filter(Boolean)
					.join("\n")
					.trim()
					.slice(-2000);
				throw new StackCleanupError(
					`Stack runtime cleanup failed for ${compose.appName}: ${detail || error.message}`,
					report,
					{ cause: error },
				);
			}
			const detail = [error.stderr, error.stdout, error.message]
				.filter(Boolean)
				.join("\n")
				.trim()
				.slice(-2000);
			throw new Error(
				`Compose runtime cleanup failed for ${compose.appName}: ${detail}`,
				{ cause: error },
			);
		}
		throw error;
	}
};

export const startCompose = async (composeId: string) => {
	const compose = await findComposeById(composeId);
	try {
		const { COMPOSE_PATH } = paths(!!compose.serverId);

		const projectPath = join(COMPOSE_PATH, compose.appName, "code");
		const path =
			compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath;
		const baseCommand = `env -i PATH="$PATH" docker compose -p ${quote([compose.appName])} -f ${quote([path])} up -d`;
		if (compose.composeType === "docker-compose") {
			await withHostBuildAdmission(
				{ serverId: compose.serverId, operation: "compose-start" },
				async ({ prepareCommand, signal }) => {
					const command = compose.serverId
						? `cd ${quote([projectPath])} && ${baseCommand}`
						: baseCommand;
					const admittedCommand = await prepareCommand(command);
					if (compose.serverId) {
						await execAsyncRemote(
							compose.serverId,
							admittedCommand,
							undefined,
							signal,
						);
					} else {
						await execAsync(admittedCommand, {
							cwd: projectPath,
							signal,
						});
					}
				},
			);
		}

		await updateCompose(composeId, {
			composeStatus: "done",
		});
	} catch (error) {
		await updateCompose(composeId, {
			composeStatus: "idle",
		});
		throw error;
	}

	return true;
};

export const stopCompose = async (composeId: string) => {
	const compose = await findComposeById(composeId);
	try {
		const { COMPOSE_PATH } = paths(!!compose.serverId);
		if (compose.composeType === "docker-compose") {
			if (compose.serverId) {
				await execAsyncRemote(
					compose.serverId,
					`cd ${join(COMPOSE_PATH, compose.appName)} && env -i PATH="$PATH" docker compose -p ${
						compose.appName
					} stop`,
				);
			} else {
				await execAsync(
					`env -i PATH="$PATH" docker compose -p ${compose.appName} stop`,
					{
						cwd: join(COMPOSE_PATH, compose.appName),
					},
				);
			}
		}

		if (compose.composeType === "stack") {
			if (compose.serverId) {
				await execAsyncRemote(
					compose.serverId,
					`docker stack rm ${compose.appName}`,
				);
			} else {
				await execAsync(`docker stack rm ${compose.appName}`);
			}
		}

		await updateCompose(composeId, {
			composeStatus: "idle",
		});
	} catch (error) {
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		throw error;
	}

	return true;
};
