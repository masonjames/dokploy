import { beforeEach, expect, test, vi } from "vitest";

const deployMock = vi.hoisted(() => vi.fn());
const findApplicationByIdMock = vi.hoisted(() => vi.fn());
const auditMock = vi.hoisted(() => vi.fn());

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: true,
	findApplicationById: findApplicationByIdMock,
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

vi.mock("@/server/api/utils/audit", () => ({ audit: auditMock }));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanQueuesByApplication: vi.fn(),
	killDockerBuild: vi.fn(),
	myQueue: { add: vi.fn() },
}));

vi.mock("@/server/utils/deploy", () => ({
	cancelDeployment: vi.fn(),
	deploy: deployMock,
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

beforeEach(() => {
	vi.clearAllMocks();
	findApplicationByIdMock.mockResolvedValue({
		applicationId: "app-1",
		appName: "example-app",
		serverId: "server-1",
	});
});

test("returns the exact Inngest deployment job ID", async () => {
	deployMock.mockResolvedValue({ jobId: "inngest-job-42" });

	await expect(caller.redeploy({ applicationId: "app-1" })).resolves.toEqual({
		queued: true,
		queue: "inngest",
		jobId: "inngest-job-42",
	});
	expect(auditMock).toHaveBeenCalledOnce();
});

test("fails closed when cloud enqueue returns no job ID", async () => {
	deployMock.mockResolvedValue({ error: "enqueue failed" });

	await expect(caller.redeploy({ applicationId: "app-1" })).rejects.toThrow(
		"Cloud deployment was not queued with a job ID",
	);
	expect(auditMock).not.toHaveBeenCalled();
});
