import { db } from "@dokploy/server/db";
import { applications } from "@dokploy/server/db/schema";
import { getRemoteDocker } from "@dokploy/server/utils/servers/remote-docker";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";

const IMMUTABLE_DIGEST_RE = /@(sha256:[a-f0-9]{64})$/;
const FAILED_TASK_STATES = new Set([
	"failed",
	"orphaned",
	"rejected",
	"remove",
	"shutdown",
]);

type RuntimeHealth =
	| "healthy"
	| "degraded"
	| "unhealthy"
	| "stopped"
	| "not-found";

type RuntimeMode =
	| "replicated"
	| "global"
	| "replicated-job"
	| "global-job"
	| "container"
	| "unknown";

type RuntimeKind = "swarm-service" | "container" | "not-found";

type ContainerHealthCounts = {
	healthy: number;
	unhealthy: number;
	starting: number;
	none: number;
	unavailable: number;
};

type RuntimeTask = {
	DesiredState?: string;
	Spec?: {
		ContainerSpec?: {
			Image?: string;
		};
	};
	Status?: {
		State?: string;
		ContainerStatus?: {
			ContainerID?: string;
		};
	};
};

const emptyContainerHealth = (): ContainerHealthCounts => ({
	healthy: 0,
	unhealthy: 0,
	starting: 0,
	none: 0,
	unavailable: 0,
});

const uniqueSorted = (values: Array<string | undefined | null>) =>
	[
		...new Set(values.filter((value): value is string => Boolean(value))),
	].sort();

const extractDigest = (imageReference?: string | null) =>
	imageReference?.match(IMMUTABLE_DIGEST_RE)?.[1] ?? null;

const isDockerNotFound = (error: unknown) => {
	if (!error || typeof error !== "object") return false;
	const candidate = error as {
		statusCode?: number;
		status?: number;
		reason?: { statusCode?: number };
	};
	return (
		candidate.statusCode === 404 ||
		candidate.status === 404 ||
		candidate.reason?.statusCode === 404
	);
};

const imageMatches = (
	desiredImage: string | null,
	runningImageReferences: string[],
	runningImageDigest: string | null,
) => {
	if (!desiredImage || runningImageReferences.length === 0) return null;
	const desiredDigest = extractDigest(desiredImage);
	if (desiredDigest) return desiredDigest === runningImageDigest;
	return (
		runningImageReferences.length === 1 &&
		runningImageReferences[0] === desiredImage
	);
};

const getRuntimeMode = (
	mode: Record<string, unknown> | undefined,
): RuntimeMode => {
	if (mode?.Replicated) return "replicated";
	if (mode?.Global) return "global";
	if (mode?.ReplicatedJob) return "replicated-job";
	if (mode?.GlobalJob) return "global-job";
	return "unknown";
};

const getDesiredReplicas = ({
	mode,
	activeTasks,
	configuredReplicas,
	serviceDesiredTasks,
}: {
	mode: Record<string, unknown> | undefined;
	activeTasks: RuntimeTask[];
	configuredReplicas: number;
	serviceDesiredTasks?: number;
}) => {
	const replicated = mode?.Replicated as { Replicas?: number } | undefined;
	if (typeof replicated?.Replicas === "number") return replicated.Replicas;
	const replicatedJob = mode?.ReplicatedJob as
		| { MaxConcurrent?: number }
		| undefined;
	if (typeof replicatedJob?.MaxConcurrent === "number") {
		return replicatedJob.MaxConcurrent;
	}
	if (mode?.Global || mode?.GlobalJob) {
		return typeof serviceDesiredTasks === "number"
			? serviceDesiredTasks
			: activeTasks.length;
	}
	if (typeof serviceDesiredTasks === "number") return serviceDesiredTasks;
	return configuredReplicas;
};

const inspectRunningContainers = async (
	docker: Awaited<ReturnType<typeof getRemoteDocker>>,
	runningTasks: RuntimeTask[],
) => {
	const health = emptyContainerHealth();
	const imageIds: string[] = [];
	let healthCheckConfigured = false;

	await Promise.all(
		runningTasks.map(async (task) => {
			const containerId = task.Status?.ContainerStatus?.ContainerID;
			if (!containerId) {
				health.unavailable += 1;
				return;
			}
			try {
				const container = await docker.getContainer(containerId).inspect();
				if (container.Image) imageIds.push(container.Image);
				if (container.State.Health) healthCheckConfigured = true;
				switch (container.State.Health?.Status) {
					case "healthy":
						health.healthy += 1;
						break;
					case "unhealthy":
						health.unhealthy += 1;
						break;
					case "starting":
						health.starting += 1;
						break;
					default:
						health.none += 1;
				}
			} catch (error) {
				// A manager cannot inspect a container scheduled on another Swarm node.
				// The task's immutable image reference remains authoritative evidence.
				if (isDockerNotFound(error)) {
					health.unavailable += 1;
					return;
				}
				throw error;
			}
		}),
	);

	return {
		health,
		healthCheckConfigured,
		imageIds: uniqueSorted(imageIds),
	};
};

const determineServiceHealth = ({
	desiredReplicas,
	runningReplicas,
	pendingReplicas,
	failedReplicas,
	replicaConverged,
	updateState,
	containerHealth,
}: {
	desiredReplicas: number;
	runningReplicas: number;
	pendingReplicas: number;
	failedReplicas: number;
	replicaConverged: boolean;
	updateState: string | null;
	containerHealth: ContainerHealthCounts;
}): RuntimeHealth => {
	if (desiredReplicas === 0) return "stopped";
	if (
		failedReplicas > 0 ||
		containerHealth.unhealthy > 0 ||
		updateState === "paused" ||
		updateState === "rollback_paused"
	) {
		return "unhealthy";
	}
	if (runningReplicas === 0 && pendingReplicas === 0) return "unhealthy";
	if (
		!replicaConverged ||
		pendingReplicas > 0 ||
		containerHealth.starting > 0 ||
		updateState === "updating" ||
		updateState === "rollback_started"
	) {
		return "degraded";
	}
	return "healthy";
};

/**
 * Returns a deliberately narrow, read-only runtime projection. It extracts
 * only image and health evidence from Docker and never returns service specs,
 * container environment variables, registry credentials, or task errors.
 */
export const getApplicationRuntimeStatus = async (applicationId: string) => {
	const application = await db.query.applications.findFirst({
		where: eq(applications.applicationId, applicationId),
		columns: {
			applicationId: true,
			appName: true,
			sourceType: true,
			dockerImage: true,
			replicas: true,
			serverId: true,
		},
	});
	if (!application) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Application not found",
		});
	}

	const docker = await getRemoteDocker(application.serverId);
	const service = docker.getService(application.appName);

	try {
		const inspected = await service.inspect();
		const serviceSpec = inspected.Spec as
			| {
					Mode?: Record<string, unknown>;
					TaskTemplate?: {
						ContainerSpec?: {
							Image?: string;
							HealthCheck?: { Test?: string[] };
						};
					};
			  }
			| undefined;
		const tasks = (await docker.listTasks({
			filters: JSON.stringify({ service: [inspected.ID] }),
		})) as RuntimeTask[];
		const activeTasks = tasks.filter(
			(task) => task.DesiredState?.toLowerCase() === "running",
		);
		const runningTasks = activeTasks.filter(
			(task) => task.Status?.State?.toLowerCase() === "running",
		);
		const failedReplicas = activeTasks.filter((task) =>
			FAILED_TASK_STATES.has(task.Status?.State?.toLowerCase() ?? ""),
		).length;
		const pendingReplicas =
			activeTasks.length - runningTasks.length - failedReplicas;
		const desiredReplicas = getDesiredReplicas({
			mode: serviceSpec?.Mode,
			activeTasks,
			configuredReplicas: application.replicas,
			serviceDesiredTasks: inspected.ServiceStatus?.DesiredTasks,
		});
		const runningImageReferencesForTasks = runningTasks
			.map((task) => task.Spec?.ContainerSpec?.Image)
			.filter((value): value is string => Boolean(value));
		const runningImageReferences = uniqueSorted(runningImageReferencesForTasks);
		const taskDigests = runningImageReferencesForTasks.map(extractDigest);
		const runningImageDigests = uniqueSorted(taskDigests);
		const allRunningImagesDigestPinned =
			runningTasks.length > 0 &&
			runningImageReferencesForTasks.length === runningTasks.length &&
			taskDigests.every(Boolean);
		const runningImageDigest =
			allRunningImagesDigestPinned && runningImageDigests.length === 1
				? (runningImageDigests[0] ?? null)
				: null;
		const runtimeDesiredImage =
			serviceSpec?.TaskTemplate?.ContainerSpec?.Image ?? null;
		const {
			health: containerHealth,
			healthCheckConfigured: containerHealthCheckConfigured,
			imageIds: runningImageIds,
		} = await inspectRunningContainers(docker, runningTasks);
		const replicaConverged =
			runningTasks.length === desiredReplicas &&
			pendingReplicas === 0 &&
			failedReplicas === 0;
		const updateState = inspected.UpdateStatus?.State ?? null;
		const healthCheckTest =
			serviceSpec?.TaskTemplate?.ContainerSpec?.HealthCheck?.Test;

		return {
			applicationId: application.applicationId,
			appName: application.appName,
			serverId: application.serverId,
			sourceType: application.sourceType,
			configuredImage: application.dockerImage,
			runtimeKind: "swarm-service" as RuntimeKind,
			mode: getRuntimeMode(serviceSpec?.Mode),
			imageEvidence: "swarm-task-spec" as const,
			runtimeDesiredImage,
			runtimeDesiredImageDigest: extractDigest(runtimeDesiredImage),
			runningImageReferences,
			runningImageDigests,
			runningImageDigest,
			runningImageIds,
			allRunningImagesDigestPinned,
			imageConverged:
				runningTasks.length > 0 &&
				runningImageReferencesForTasks.length === runningTasks.length &&
				runningImageReferences.length === 1,
			matchesConfiguredImage: imageMatches(
				application.dockerImage,
				runningImageReferences,
				runningImageDigest,
			),
			matchesRuntimeDesiredImage: imageMatches(
				runtimeDesiredImage,
				runningImageReferences,
				runningImageDigest,
			),
			desiredReplicas,
			activeReplicas: activeTasks.length,
			runningReplicas: runningTasks.length,
			pendingReplicas,
			failedReplicas,
			replicaConverged,
			healthCheckConfigured:
				Boolean(healthCheckTest?.length && healthCheckTest[0] !== "NONE") ||
				containerHealthCheckConfigured,
			containerHealth,
			updateState,
			health: determineServiceHealth({
				desiredReplicas,
				runningReplicas: runningTasks.length,
				pendingReplicas,
				failedReplicas,
				replicaConverged,
				updateState,
				containerHealth,
			}),
		};
	} catch (error) {
		if (!isDockerNotFound(error)) throw error;
	}

	const container = docker.getContainer(application.appName);
	try {
		const inspected = await container.inspect();
		const running = inspected.State.Running;
		const runningImageReferences = running
			? uniqueSorted([inspected.Config.Image])
			: [];
		const runningImageDigests = uniqueSorted(
			runningImageReferences.map(extractDigest),
		);
		const runningImageDigest = runningImageDigests[0] ?? null;
		const containerHealth = emptyContainerHealth();
		if (running) {
			switch (inspected.State.Health?.Status) {
				case "healthy":
					containerHealth.healthy = 1;
					break;
				case "unhealthy":
					containerHealth.unhealthy = 1;
					break;
				case "starting":
					containerHealth.starting = 1;
					break;
				default:
					containerHealth.none = 1;
			}
		}

		return {
			applicationId: application.applicationId,
			appName: application.appName,
			serverId: application.serverId,
			sourceType: application.sourceType,
			configuredImage: application.dockerImage,
			runtimeKind: "container" as RuntimeKind,
			mode: "container" as RuntimeMode,
			imageEvidence: "container-inspect" as const,
			runtimeDesiredImage: inspected.Config.Image || null,
			runtimeDesiredImageDigest: extractDigest(inspected.Config.Image),
			runningImageReferences,
			runningImageDigests,
			runningImageDigest,
			runningImageIds: running ? uniqueSorted([inspected.Image]) : [],
			allRunningImagesDigestPinned: running && Boolean(runningImageDigest),
			imageConverged: running && runningImageReferences.length === 1,
			matchesConfiguredImage: imageMatches(
				application.dockerImage,
				runningImageReferences,
				runningImageDigest,
			),
			matchesRuntimeDesiredImage: imageMatches(
				inspected.Config.Image || null,
				runningImageReferences,
				runningImageDigest,
			),
			desiredReplicas: 1,
			activeReplicas: running ? 1 : 0,
			runningReplicas: running ? 1 : 0,
			pendingReplicas: inspected.State.Restarting ? 1 : 0,
			failedReplicas: !running && !inspected.State.Restarting ? 1 : 0,
			replicaConverged: running,
			healthCheckConfigured: Boolean(inspected.State.Health),
			containerHealth,
			updateState: null,
			health: !running
				? ("stopped" as RuntimeHealth)
				: containerHealth.unhealthy > 0
					? ("unhealthy" as RuntimeHealth)
					: containerHealth.starting > 0
						? ("degraded" as RuntimeHealth)
						: ("healthy" as RuntimeHealth),
		};
	} catch (error) {
		if (!isDockerNotFound(error)) throw error;
	}

	return {
		applicationId: application.applicationId,
		appName: application.appName,
		serverId: application.serverId,
		sourceType: application.sourceType,
		configuredImage: application.dockerImage,
		runtimeKind: "not-found" as RuntimeKind,
		mode: "unknown" as RuntimeMode,
		imageEvidence: "none" as const,
		runtimeDesiredImage: null,
		runtimeDesiredImageDigest: null,
		runningImageReferences: [],
		runningImageDigests: [],
		runningImageDigest: null,
		runningImageIds: [],
		allRunningImagesDigestPinned: false,
		imageConverged: false,
		matchesConfiguredImage: null,
		matchesRuntimeDesiredImage: null,
		desiredReplicas: application.replicas,
		activeReplicas: 0,
		runningReplicas: 0,
		pendingReplicas: 0,
		failedReplicas: 0,
		replicaConverged: false,
		healthCheckConfigured: false,
		containerHealth: emptyContainerHealth(),
		updateState: null,
		health: "not-found" as RuntimeHealth,
	};
};
