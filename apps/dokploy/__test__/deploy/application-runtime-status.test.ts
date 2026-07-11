import { beforeEach, expect, test, vi } from "vitest";

const findFirstMock = vi.hoisted(() => vi.fn());
const getRemoteDockerMock = vi.hoisted(() => vi.fn());

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			applications: { findFirst: findFirstMock },
		},
	},
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: getRemoteDockerMock,
}));

import { getApplicationRuntimeStatus } from "@dokploy/server/services/application-runtime";

const candidateImage = `ghcr.io/example/app@sha256:${"a".repeat(64)}`;
const previousImage = `ghcr.io/example/app@sha256:${"b".repeat(64)}`;

beforeEach(() => {
	vi.clearAllMocks();
	findFirstMock.mockResolvedValue({
		applicationId: "app-1",
		appName: "example-app",
		sourceType: "docker",
		dockerImage: candidateImage,
		replicas: 2,
		serverId: "server-1",
	});
});

test("returns exact digest, replica convergence, and sanitized Swarm health", async () => {
	const serviceInspect = vi.fn().mockResolvedValue({
		ID: "service-1",
		Spec: {
			Mode: { Replicated: { Replicas: 2 } },
			TaskTemplate: {
				ContainerSpec: {
					Image: candidateImage,
					HealthCheck: { Test: ["CMD", "curl", "--fail", "/health"] },
					Env: ["PASSWORD=must-not-leak"],
				},
			},
		},
		// Runtime status can lag the service spec during an update; the spec wins.
		ServiceStatus: { DesiredTasks: 0 },
		UpdateStatus: { State: "completed" },
	});
	const listTasks = vi.fn().mockResolvedValue([
		{
			DesiredState: "running",
			Spec: { ContainerSpec: { Image: candidateImage } },
			Status: {
				State: "running",
				ContainerStatus: { ContainerID: "container-1" },
			},
		},
		{
			DesiredState: "running",
			Spec: { ContainerSpec: { Image: candidateImage } },
			Status: {
				State: "running",
				ContainerStatus: { ContainerID: "container-on-worker" },
			},
		},
	]);
	const getContainer = vi.fn((containerId: string) => ({
		inspect:
			containerId === "container-1"
				? vi.fn().mockResolvedValue({
						Image: `sha256:${"1".repeat(64)}`,
						State: { Health: { Status: "healthy" } },
						Config: { Image: candidateImage },
					})
				: vi.fn().mockRejectedValue({ statusCode: 404 }),
	}));
	getRemoteDockerMock.mockResolvedValue({
		getService: vi.fn(() => ({ inspect: serviceInspect })),
		listTasks,
		getContainer,
	});

	const result = await getApplicationRuntimeStatus("app-1");

	expect(result).toMatchObject({
		applicationId: "app-1",
		runtimeKind: "swarm-service",
		imageEvidence: "swarm-task-spec",
		runtimeDesiredImage: candidateImage,
		runningImageDigest: `sha256:${"a".repeat(64)}`,
		runningImageReferences: [candidateImage],
		allRunningImagesDigestPinned: true,
		imageConverged: true,
		matchesConfiguredImage: true,
		matchesRuntimeDesiredImage: true,
		desiredReplicas: 2,
		runningReplicas: 2,
		pendingReplicas: 0,
		failedReplicas: 0,
		replicaConverged: true,
		healthCheckConfigured: true,
		containerHealth: {
			healthy: 1,
			unhealthy: 0,
			starting: 0,
			none: 0,
			unavailable: 1,
		},
		health: "healthy",
	});
	expect(result.runningImageIds).toEqual([`sha256:${"1".repeat(64)}`]);
	expect(listTasks).toHaveBeenCalledWith({
		filters: JSON.stringify({ service: ["service-1"] }),
	});
	expect(JSON.stringify(result)).not.toContain("must-not-leak");
});

test("reports mixed running task digests during a rolling update", async () => {
	getRemoteDockerMock.mockResolvedValue({
		getService: vi.fn(() => ({
			inspect: vi.fn().mockResolvedValue({
				ID: "service-1",
				Spec: {
					Mode: { Replicated: { Replicas: 2 } },
					TaskTemplate: { ContainerSpec: { Image: candidateImage } },
				},
				UpdateStatus: { State: "updating" },
			}),
		})),
		listTasks: vi.fn().mockResolvedValue([
			{
				DesiredState: "running",
				Spec: { ContainerSpec: { Image: previousImage } },
				Status: { State: "running", ContainerStatus: {} },
			},
			{
				DesiredState: "running",
				Spec: { ContainerSpec: { Image: candidateImage } },
				Status: { State: "running", ContainerStatus: {} },
			},
		]),
		getContainer: vi.fn(),
	});

	const result = await getApplicationRuntimeStatus("app-1");

	expect(result.runningImageDigests).toEqual([
		`sha256:${"a".repeat(64)}`,
		`sha256:${"b".repeat(64)}`,
	]);
	expect(result.runningImageDigest).toBeNull();
	expect(result.imageConverged).toBe(false);
	expect(result.matchesConfiguredImage).toBe(false);
	expect(result.updateState).toBe("updating");
	expect(result.health).toBe("degraded");
});

test("falls back to an exact standalone container without exposing its config", async () => {
	const containerInspect = vi.fn().mockResolvedValue({
		Image: `sha256:${"c".repeat(64)}`,
		Config: {
			Image: candidateImage,
			Env: ["TOKEN=must-not-leak"],
		},
		State: {
			Running: true,
			Restarting: false,
			Health: { Status: "unhealthy" },
		},
	});
	getRemoteDockerMock.mockResolvedValue({
		getService: vi.fn(() => ({
			inspect: vi.fn().mockRejectedValue({ statusCode: 404 }),
		})),
		getContainer: vi.fn(() => ({ inspect: containerInspect })),
	});

	const result = await getApplicationRuntimeStatus("app-1");

	expect(result).toMatchObject({
		runtimeKind: "container",
		imageEvidence: "container-inspect",
		runningImageDigest: `sha256:${"a".repeat(64)}`,
		runningImageIds: [`sha256:${"c".repeat(64)}`],
		desiredReplicas: 1,
		runningReplicas: 1,
		healthCheckConfigured: true,
		health: "unhealthy",
	});
	expect(JSON.stringify(result)).not.toContain("must-not-leak");
});

test("does not misclassify a Docker transport error as a missing runtime", async () => {
	const transportError = Object.assign(new Error("connection refused"), {
		statusCode: 503,
	});
	const getContainer = vi.fn();
	getRemoteDockerMock.mockResolvedValue({
		getService: vi.fn(() => ({
			inspect: vi.fn().mockRejectedValue(transportError),
		})),
		getContainer,
	});

	await expect(getApplicationRuntimeStatus("app-1")).rejects.toBe(
		transportError,
	);
	expect(getContainer).not.toHaveBeenCalled();
});
