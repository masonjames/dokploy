import { beforeEach, expect, test, vi } from "vitest";

const prepareImmutableApplicationImageMock = vi.hoisted(() => vi.fn());
const getImmutableApplicationReleaseSnapshotMock = vi.hoisted(() => vi.fn());
const getApplicationRuntimeStatusMock = vi.hoisted(() => vi.fn());
const findApplicationByIdMock = vi.hoisted(() => vi.fn());
const reserveImmutableImageDeploymentMock = vi.hoisted(() => vi.fn());
const markImmutableImageDeploymentQueuedMock = vi.hoisted(() => vi.fn());
const queueAddMock = vi.hoisted(() => vi.fn());
const queueGetJobMock = vi.hoisted(() => vi.fn());
const checkServiceAccessMock = vi.hoisted(() => vi.fn());
const ensureImmutableReleaseQueueReconciledMock = vi.hoisted(() => vi.fn());

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	findApplicationById: findApplicationByIdMock,
	getApplicationRuntimeStatus: getApplicationRuntimeStatusMock,
	getImmutableApplicationReleaseSnapshot:
		getImmutableApplicationReleaseSnapshotMock,
	prepareImmutableApplicationImage: prepareImmutableApplicationImageMock,
	reserveImmutableImageDeployment: reserveImmutableImageDeploymentMock,
	markImmutableImageDeploymentQueued: markImmutableImageDeploymentQueuedMock,
}));

vi.mock("@dokploy/server/db", () => ({
	db: { query: {} },
}));

vi.mock("@dokploy/server/services/permission", () => ({
	addNewService: vi.fn(),
	checkServiceAccess: checkServiceAccessMock,
	checkServicePermissionAndAccess: vi.fn(),
	findMemberByUserId: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanQueuesByApplication: vi.fn(),
	ensureImmutableReleaseQueueReconciled:
		ensureImmutableReleaseQueueReconciledMock,
	killDockerBuild: vi.fn(),
	myQueue: { add: queueAddMock, getJob: queueGetJobMock },
}));

vi.mock("@/server/utils/deploy", () => ({
	cancelDeployment: vi.fn(),
	deploy: vi.fn(),
}));

import { applicationRouter } from "@/server/api/routers/application";

const caller = applicationRouter.createCaller({
	session: {
		userId: "user-1",
		activeOrganizationId: "org-1",
	},
	user: {
		id: "user-1",
		role: "owner",
		ownerId: "user-1",
		email: "owner@example.com",
		enableEnterpriseFeatures: true,
		isValidEnterpriseLicense: true,
	},
	req: { headers: {} },
	res: {},
} as never);

const application = {
	applicationId: "app-1",
	appName: "example-app",
	serverId: null,
	sourceType: "docker",
	dockerImage: `ghcr.io/example/app@sha256:${"a".repeat(64)}`,
	environment: { project: { organizationId: "org-1" } },
};
const expectedGeneration = "b".repeat(64);
const expectedNonImageConfigHash = "c".repeat(64);

beforeEach(() => {
	vi.clearAllMocks();
	findApplicationByIdMock.mockResolvedValue(application);
	getImmutableApplicationReleaseSnapshotMock.mockResolvedValue({
		applicationId: "app-1",
		dockerImage: application.dockerImage,
		releaseGeneration: expectedGeneration,
		nonImageConfigHash: expectedNonImageConfigHash,
		deployments: [],
	});
	queueGetJobMock.mockResolvedValue(null);
	reserveImmutableImageDeploymentMock.mockImplementation(async (input) => ({
		logicalJobId: `dockhand-release-${input.idempotencyKey}`,
		physicalJobId: `dockhand-release-${input.idempotencyKey}-attempt-1`,
		attempt: 1,
		shouldEnqueue: true,
		status: "reserved",
	}));
	markImmutableImageDeploymentQueuedMock.mockResolvedValue(undefined);
	ensureImmutableReleaseQueueReconciledMock.mockResolvedValue(undefined);
});

test("prepares a digest-pinned image through the compare-and-swap mutation", async () => {
	const candidateImage = `ghcr.io/example/app@sha256:${"a".repeat(64)}`;
	const expectedGeneration = "b".repeat(64);
	const expectedNonImageConfigHash = "c".repeat(64);
	prepareImmutableApplicationImageMock.mockResolvedValue({
		applicationId: "app-1",
		previous: { dockerImage: "ghcr.io/example/app:sha-old" },
		current: { dockerImage: candidateImage },
	});

	const result = await caller.prepareImmutableImage({
		applicationId: "app-1",
		expectedCurrentImage: "ghcr.io/example/app:sha-old",
		candidateImage,
		expectedGeneration,
		expectedNonImageConfigHash,
	});

	expect(prepareImmutableApplicationImageMock).toHaveBeenCalledWith({
		applicationId: "app-1",
		expectedOrganizationId: "org-1",
		expectedCurrentImage: "ghcr.io/example/app:sha-old",
		candidateImage,
		expectedGeneration,
		expectedNonImageConfigHash,
	});
	expect(result.current.dockerImage).toBe(candidateImage);
});

test("reads a secret-free immutable release snapshot", async () => {
	getImmutableApplicationReleaseSnapshotMock.mockResolvedValue({
		applicationId: "app-1",
		dockerImage: `ghcr.io/example/app@sha256:${"a".repeat(64)}`,
		releaseGeneration: "b".repeat(64),
		nonImageConfigHash: "c".repeat(64),
		nonImageConfig: { applicationId: "app-1", sourceType: "docker" },
		environmentNames: ["PUBLIC_FLAG", "SECRET_TOKEN"],
		applicationStatus: "done",
		deployments: [],
	});

	const result = await caller.immutableReleaseSnapshot({
		applicationId: "app-1",
	});

	expect(getImmutableApplicationReleaseSnapshotMock).toHaveBeenCalledWith(
		"app-1",
	);
	expect(checkServiceAccessMock).toHaveBeenCalledWith(
		expect.anything(),
		"app-1",
		"read",
	);
	expect(result.releaseGeneration).toBe("b".repeat(64));
	expect(result.nonImageConfig).toEqual(
		expect.objectContaining({ applicationId: "app-1", sourceType: "docker" }),
	);
	expect(result.environmentNames).toEqual(["PUBLIC_FLAG", "SECRET_TOKEN"]);
	expect(JSON.stringify(result)).not.toContain("secret-value");
});

test("reads sanitized runtime image and health evidence", async () => {
	getApplicationRuntimeStatusMock.mockResolvedValue({
		applicationId: "app-1",
		runtimeKind: "swarm-service",
		runningImageDigest: `sha256:${"a".repeat(64)}`,
		replicaConverged: true,
		health: "healthy",
	});

	const result = await caller.runtimeStatus({ applicationId: "app-1" });

	expect(getApplicationRuntimeStatusMock).toHaveBeenCalledWith("app-1");
	expect(result).toMatchObject({
		runningImageDigest: `sha256:${"a".repeat(64)}`,
		replicaConverged: true,
		health: "healthy",
	});
});

test("redeploy returns the exact in-memory queue job ID", async () => {
	queueAddMock.mockResolvedValue({ id: "deployment-job-42" });

	const result = await caller.redeploy({ applicationId: "app-1" });

	expect(result).toEqual({
		queued: true,
		queue: "in-memory",
		jobId: "deployment-job-42",
	});
});

test("immutable image deployment is idempotent under duplicate submission", async () => {
	const idempotencyKey = "d".repeat(64);
	const jobId = `dockhand-release-${idempotencyKey}`;
	queueAddMock.mockResolvedValue({ id: `${jobId}-attempt-1` });

	await expect(
		caller.requestImmutableImageDeployment({
			applicationId: "app-1",
			expectedImage: application.dockerImage,
			expectedGeneration,
			expectedNonImageConfigHash,
			idempotencyKey,
		}),
	).resolves.toEqual({ queued: true, queue: "in-memory", jobId });

	reserveImmutableImageDeploymentMock.mockResolvedValue({
		logicalJobId: jobId,
		physicalJobId: `${jobId}-attempt-1`,
		attempt: 1,
		shouldEnqueue: false,
		status: "queued",
	});
	await expect(
		caller.requestImmutableImageDeployment({
			applicationId: "app-1",
			expectedImage: application.dockerImage,
			expectedGeneration,
			expectedNonImageConfigHash,
			idempotencyKey,
		}),
	).resolves.toEqual({ queued: true, queue: "in-memory", jobId });

	expect(queueAddMock).toHaveBeenCalledOnce();
	expect(queueAddMock).toHaveBeenCalledWith(
		"deployments",
		expect.objectContaining({
			applicationId: "app-1",
			titleLog: `Dockhand governed release ${idempotencyKey}`,
			releaseGuard: expect.objectContaining({
				idempotencyKey,
				organizationId: "org-1",
				expectedGeneration,
				expectedNonImageConfigHash,
			}),
		}),
		{ jobId: `${jobId}-attempt-1` },
	);
	expect(ensureImmutableReleaseQueueReconciledMock).toHaveBeenCalledTimes(2);
});

test.each([
	"immutableReleaseSnapshot",
	"prepareImmutableImage",
	"requestImmutableImageDeployment",
] as const)("rejects a foreign organization in %s", async (operation) => {
	findApplicationByIdMock.mockResolvedValue({
		...application,
		environment: { project: { organizationId: "org-2" } },
	});
	const payloads = {
		immutableReleaseSnapshot: { applicationId: "app-1" },
		prepareImmutableImage: {
			applicationId: "app-1",
			expectedCurrentImage: application.dockerImage,
			candidateImage: `ghcr.io/example/app@sha256:${"f".repeat(64)}`,
			expectedGeneration,
			expectedNonImageConfigHash,
		},
		requestImmutableImageDeployment: {
			applicationId: "app-1",
			expectedImage: application.dockerImage,
			expectedGeneration,
			expectedNonImageConfigHash,
			idempotencyKey: "d".repeat(64),
		},
	};

	await expect(caller[operation](payloads[operation] as never)).rejects.toThrow(
		"not authorized",
	);
});

test("immutable image deployment rejects a stale desired image", async () => {
	await expect(
		caller.requestImmutableImageDeployment({
			applicationId: "app-1",
			expectedImage: `ghcr.io/example/app@sha256:${"b".repeat(64)}`,
			expectedGeneration,
			expectedNonImageConfigHash,
			idempotencyKey: "d".repeat(64),
		}),
	).rejects.toThrow("Application image changed before deployment request");
	expect(queueAddMock).not.toHaveBeenCalled();
});

test("immutable deployment fails closed until startup reconciliation succeeds", async () => {
	ensureImmutableReleaseQueueReconciledMock.mockRejectedValue(
		new Error("reconciliation unavailable"),
	);

	await expect(
		caller.requestImmutableImageDeployment({
			applicationId: "app-1",
			expectedImage: application.dockerImage,
			expectedGeneration,
			expectedNonImageConfigHash,
			idempotencyKey: "d".repeat(64),
		}),
	).rejects.toThrow("reconciliation unavailable");
	expect(reserveImmutableImageDeploymentMock).not.toHaveBeenCalled();
	expect(queueAddMock).not.toHaveBeenCalled();
});

test("immutable image deployment rejects a stale generation before enqueue", async () => {
	await expect(
		caller.requestImmutableImageDeployment({
			applicationId: "app-1",
			expectedImage: application.dockerImage,
			expectedGeneration: "9".repeat(64),
			expectedNonImageConfigHash,
			idempotencyKey: "d".repeat(64),
		}),
	).rejects.toThrow("generation changed before deployment request");
	expect(queueAddMock).not.toHaveBeenCalled();
});
