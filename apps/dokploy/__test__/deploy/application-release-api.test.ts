import { beforeEach, expect, test, vi } from "vitest";

const prepareImmutableApplicationImageMock = vi.hoisted(() => vi.fn());
const getApplicationRuntimeStatusMock = vi.hoisted(() => vi.fn());
const findApplicationByIdMock = vi.hoisted(() => vi.fn());
const queueAddMock = vi.hoisted(() => vi.fn());

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	findApplicationById: findApplicationByIdMock,
	getApplicationRuntimeStatus: getApplicationRuntimeStatusMock,
	prepareImmutableApplicationImage: prepareImmutableApplicationImageMock,
}));

vi.mock("@dokploy/server/db", () => ({
	db: { query: {} },
}));

vi.mock("@dokploy/server/services/permission", () => ({
	addNewService: vi.fn(),
	checkServiceAccess: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	findMemberByUserId: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanQueuesByApplication: vi.fn(),
	killDockerBuild: vi.fn(),
	myQueue: { add: queueAddMock },
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
};

beforeEach(() => {
	vi.clearAllMocks();
	findApplicationByIdMock.mockResolvedValue(application);
});

test("prepares a digest-pinned image through the compare-and-swap mutation", async () => {
	const candidateImage = `ghcr.io/example/app@sha256:${"a".repeat(64)}`;
	prepareImmutableApplicationImageMock.mockResolvedValue({
		applicationId: "app-1",
		previous: { dockerImage: "ghcr.io/example/app:sha-old" },
		current: { dockerImage: candidateImage },
	});

	const result = await caller.prepareImmutableImage({
		applicationId: "app-1",
		expectedCurrentImage: "ghcr.io/example/app:sha-old",
		candidateImage,
	});

	expect(prepareImmutableApplicationImageMock).toHaveBeenCalledWith({
		applicationId: "app-1",
		expectedCurrentImage: "ghcr.io/example/app:sha-old",
		candidateImage,
	});
	expect(result.current.dockerImage).toBe(candidateImage);
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
