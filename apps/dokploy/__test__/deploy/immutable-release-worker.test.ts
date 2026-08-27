import { beforeEach, expect, test, vi } from "vitest";

const claimMock = vi.hoisted(() => vi.fn());
const finishMock = vi.hoisted(() => vi.fn());
const rebuildMock = vi.hoisted(() => vi.fn());
const updateStatusMock = vi.hoisted(() => vi.fn());

vi.mock("@dokploy/server", () => ({
	claimImmutableImageDeployment: claimMock,
	finishImmutableImageDeployment: finishMock,
	rebuildApplication: rebuildMock,
	updateApplicationStatus: updateStatusMock,
	deployApplication: vi.fn(),
	deployCompose: vi.fn(),
	deployPreviewApplication: vi.fn(),
	rebuildCompose: vi.fn(),
	rebuildPreviewApplication: vi.fn(),
	updateCompose: vi.fn(),
	updatePreviewDeployment: vi.fn(),
}));

import { processDeploymentJob } from "@/server/queues/deployments-queue";

const releaseGuard = {
	idempotencyKey: "d".repeat(64),
	organizationId: "org-1",
	attempt: 1,
	expectedImage: `ghcr.io/example/app@sha256:${"a".repeat(64)}`,
	expectedGeneration: "b".repeat(64),
	expectedNonImageConfigHash: "c".repeat(64),
};

const job = {
	id: `dockhand-release-${"d".repeat(64)}-attempt-1`,
	name: "deployments",
	data: {
		applicationId: "app-1",
		titleLog: `Dockhand governed release ${"d".repeat(64)}`,
		descriptionLog: "",
		type: "redeploy" as const,
		applicationType: "application" as const,
		releaseGuard,
	},
	timestamp: 1,
	getState: vi.fn(),
	remove: vi.fn(),
};

beforeEach(() => {
	vi.clearAllMocks();
	claimMock.mockResolvedValue(true);
	finishMock.mockResolvedValue(undefined);
	rebuildMock.mockResolvedValue(true);
});

test("revalidates the durable release claim and exact worker guard", async () => {
	await processDeploymentJob(job);

	expect(claimMock).toHaveBeenCalledWith({
		...releaseGuard,
		applicationId: "app-1",
	});
	expect(rebuildMock).toHaveBeenCalledWith({
		applicationId: "app-1",
		titleLog: job.data.titleLog,
		descriptionLog: "",
		releaseGuard,
	});
	expect(finishMock).toHaveBeenCalledWith(
		{ ...releaseGuard, applicationId: "app-1" },
		"done",
	);
});

test("a duplicate physical job cannot execute the same durable attempt", async () => {
	claimMock.mockResolvedValue(false);

	await processDeploymentJob(job);

	expect(rebuildMock).not.toHaveBeenCalled();
	expect(updateStatusMock).not.toHaveBeenCalled();
	expect(finishMock).not.toHaveBeenCalled();
});

test("deployment failure remains failed and opens a reconciled retry", async () => {
	rebuildMock.mockRejectedValue(new Error("private provider detail"));

	await expect(processDeploymentJob(job)).rejects.toThrow(
		"Governed immutable deployment failed",
	);
	expect(finishMock).toHaveBeenCalledWith(
		{ ...releaseGuard, applicationId: "app-1" },
		"error",
	);
});
