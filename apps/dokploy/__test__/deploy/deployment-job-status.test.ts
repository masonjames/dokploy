import { beforeEach, expect, test, vi } from "vitest";

const getJobMock = vi.hoisted(() => vi.fn());
const checkServicePermissionAndAccessMock = vi.hoisted(() => vi.fn());

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
}));

vi.mock("@dokploy/server/db", () => ({
	db: { query: {} },
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkServicePermissionAndAccess: checkServicePermissionAndAccessMock,
	findMemberByUserId: vi.fn(),
}));

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: { getJob: getJobMock },
}));

vi.mock("@/server/utils/deploy", () => ({
	fetchDeployApiJobs: vi.fn(),
}));

import { deploymentRouter } from "@/server/api/routers/deployment";

const caller = deploymentRouter.createCaller({
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
});

test("returns a minimal terminal status for an exact completed job", async () => {
	getJobMock.mockResolvedValue({
		id: "deployment-job-42",
		data: {
			applicationId: "app-1",
			secretBuildArgument: "must-not-leak",
		},
		timestamp: 100,
		processedOn: 110,
		finishedOn: 120,
		failedReason: "must-not-leak",
		getState: vi.fn().mockResolvedValue("completed"),
	});

	const result = await caller.queueJobStatus({ jobId: "deployment-job-42" });

	expect(checkServicePermissionAndAccessMock).toHaveBeenCalledWith(
		expect.anything(),
		"app-1",
		{ deployment: ["read"] },
	);
	expect(result).toEqual({
		jobId: "deployment-job-42",
		found: true,
		state: "completed",
		terminal: true,
		succeeded: true,
		failed: false,
		timestamp: 100,
		processedOn: 110,
		finishedOn: 120,
	});
	expect(JSON.stringify(result)).not.toContain("must-not-leak");
});

test("returns a nonterminal unknown status while a job is not observable", async () => {
	getJobMock.mockResolvedValue(null);

	await expect(
		caller.queueJobStatus({ jobId: "deployment-job-missing" }),
	).resolves.toMatchObject({
		jobId: "deployment-job-missing",
		found: false,
		state: "unknown",
		terminal: false,
	});
});
