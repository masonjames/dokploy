import { beforeEach, expect, test, vi } from "vitest";

type RequestRow = {
	idempotencyKey: string;
	applicationId: string;
	organizationId: string;
	expectedImage: string;
	expectedGeneration: string;
	expectedNonImageConfigHash: string;
	attempt: number;
	physicalJobId: string;
	status: "reserved" | "queued" | "running" | "done" | "error" | "cancelled";
	createdAt: string;
	updatedAt: string;
};

const state = vi.hoisted(() => ({ row: null as RequestRow | null }));
const leaseSqlMock = vi.hoisted(() =>
	Object.assign(vi.fn(), { end: vi.fn().mockResolvedValue(undefined) }),
);
const postgresMock = vi.hoisted(() =>
	vi.fn(
		(
			_url: string,
			_options: { max: number; max_lifetime: null; onclose: () => void },
		) => leaseSqlMock,
	),
);
const dbMock = vi.hoisted(() => {
	const insert = vi.fn(() => ({
		values: (value: RequestRow) => ({
			onConflictDoNothing: () => ({
				returning: async () => {
					if (state.row) return [];
					state.row = { ...value };
					return [state.row];
				},
			}),
		}),
	}));
	const update = vi.fn(() => ({
		set: (value: Partial<RequestRow>) => ({
			where: () => ({
				returning: async () => {
					if (!state.row) return [];
					if (value.status === "queued" && state.row.status !== "reserved")
						return [];
					if (
						value.status === "running" &&
						!(["reserved", "queued"] as const).includes(
							state.row.status as "reserved" | "queued",
						)
					)
						return [];
					if (
						(value.status === "done" || value.status === "cancelled") &&
						state.row.status !== "running"
					)
						return [];
					if (
						value.attempt &&
						!["error", "cancelled"].includes(state.row.status)
					)
						return [];
					state.row = { ...state.row, ...value };
					return [state.row];
				},
			}),
		}),
	}));
	const db = {
		execute: vi.fn(),
		insert,
		update,
		query: {
			applications: { findFirst: vi.fn() },
			immutableReleaseRequests: { findFirst: async () => state.row },
		},
	};
	return {
		...db,
		transaction: vi.fn(async (callback: (tx: typeof db) => unknown) =>
			callback(db),
		),
	};
});

vi.mock("@dokploy/server/db", () => ({ db: dbMock }));
vi.mock("postgres", () => ({ default: postgresMock }));

import {
	acquireImmutableReleaseWorkerLease,
	claimImmutableImageDeployment,
	finishImmutableImageDeployment,
	immutableApplicationReleaseSnapshot,
	markImmutableImageDeploymentQueued,
	reconcileInterruptedImmutableImageDeployments,
	reserveImmutableImageDeployment,
} from "@dokploy/server/services/application-image";

const application = {
	applicationId: "app-1",
	releaseConfigRevision: 9,
	appName: "example-app",
	environmentId: "env-1",
	dockerImage: `ghcr.io/example/app@sha256:${"a".repeat(64)}`,
	sourceType: "docker",
	serverId: null,
	buildServerId: null,
	registryId: null,
	buildRegistryId: null,
	rollbackRegistryId: null,
	ports: [],
	mounts: [],
	domains: [],
	deployments: [],
	environment: {
		project: { projectId: "project-1", organizationId: "org-1" },
	},
};
const snapshot = immutableApplicationReleaseSnapshot(application);
const input = {
	applicationId: "app-1",
	organizationId: "org-1",
	idempotencyKey: "d".repeat(64),
	expectedImage: snapshot.dockerImage,
	expectedGeneration: snapshot.releaseGeneration,
	expectedNonImageConfigHash: snapshot.nonImageConfigHash,
};

beforeEach(() => {
	state.row = null;
	(
		globalThis as typeof globalThis & {
			__dokployImmutableReleaseWorkerLease?: object;
		}
	).__dokployImmutableReleaseWorkerLease = {};
	vi.clearAllMocks();
	dbMock.query.applications.findFirst.mockResolvedValue(application);
	leaseSqlMock.mockResolvedValue([{ acquired: true }]);
});

test("holds one database session lease before startup reconciliation", async () => {
	const exitMock = vi
		.spyOn(process, "exit")
		.mockImplementation((() => undefined) as never);
	state.row = {
		...input,
		attempt: 1,
		physicalJobId: `${input.idempotencyKey}-attempt-1`,
		status: "running",
		createdAt: "2026-08-27T00:00:00Z",
		updatedAt: "2026-08-27T00:00:00Z",
	};
	expect(await acquireImmutableReleaseWorkerLease()).toBe(1);
	expect(await acquireImmutableReleaseWorkerLease()).toBe(1);
	expect(postgresMock).toHaveBeenCalledOnce();
	expect(postgresMock).toHaveBeenCalledWith(
		expect.any(String),
		expect.objectContaining({ max: 1, max_lifetime: null }),
	);
	expect(leaseSqlMock).toHaveBeenCalledOnce();
	expect(leaseSqlMock.end).not.toHaveBeenCalled();
	const options = postgresMock.mock.calls[0]?.[1] as {
		onclose: () => void;
	};
	options.onclose();
	expect(exitMock).toHaveBeenCalledWith(1);
	exitMock.mockRestore();
});

test("a second process fails closed without reconciling live attempts", async () => {
	leaseSqlMock.mockResolvedValue([{ acquired: false }]);
	await expect(acquireImmutableReleaseWorkerLease()).rejects.toThrow(
		"worker lease is already held",
	);
	expect(dbMock.update).not.toHaveBeenCalled();
	expect(leaseSqlMock.end).toHaveBeenCalledOnce();
});

test("persists one exact full-key reservation across duplicate requests", async () => {
	const first = await reserveImmutableImageDeployment(input);
	expect(first).toMatchObject({ attempt: 1, shouldEnqueue: true });
	expect(first.logicalJobId).toBe(`dockhand-release-${input.idempotencyKey}`);
	expect(first.physicalJobId).toBe(`${first.logicalJobId}-attempt-1`);

	await markImmutableImageDeploymentQueued(input.idempotencyKey, 1);
	const duplicate = await reserveImmutableImageDeployment(input);
	expect(duplicate).toMatchObject({
		attempt: 1,
		shouldEnqueue: false,
		status: "queued",
	});
});

test("re-observes the nonsecret configuration revision inside reservation", async () => {
	dbMock.query.applications.findFirst.mockResolvedValue({
		...application,
		releaseConfigRevision: application.releaseConfigRevision + 1,
	});
	await expect(reserveImmutableImageDeployment(input)).rejects.toThrow(
		"release generation changed",
	);
	expect(state.row).toBeNull();
});

test("only one worker claims an attempt and a failed attempt retries durably", async () => {
	await reserveImmutableImageDeployment(input);
	await markImmutableImageDeploymentQueued(input.idempotencyKey, 1);
	const guard = { ...input, attempt: 1 };
	expect(await claimImmutableImageDeployment(guard)).toBe(true);
	expect(await claimImmutableImageDeployment(guard)).toBe(false);
	await finishImmutableImageDeployment(guard, "error");

	const retry = await reserveImmutableImageDeployment(input);
	expect(retry).toMatchObject({ attempt: 2, shouldEnqueue: true });
	expect(retry.physicalJobId).toBe(`${retry.logicalJobId}-attempt-2`);
});

test("startup reconciliation turns a lost queued attempt into one retry", async () => {
	await reserveImmutableImageDeployment(input);
	await markImmutableImageDeploymentQueued(input.idempotencyKey, 1);
	expect(await reconcileInterruptedImmutableImageDeployments()).toBe(1);

	const retry = await reserveImmutableImageDeployment(input);
	expect(retry).toMatchObject({ attempt: 2, shouldEnqueue: true });
	expect(retry.physicalJobId).toBe(`${retry.logicalJobId}-attempt-2`);
});

test("rejects reuse of one idempotency key for divergent authority", async () => {
	await reserveImmutableImageDeployment(input);
	const divergentApplication = {
		...application,
		dockerImage: `ghcr.io/example/app@sha256:${"f".repeat(64)}`,
	};
	const divergentSnapshot =
		immutableApplicationReleaseSnapshot(divergentApplication);
	dbMock.query.applications.findFirst.mockResolvedValue(divergentApplication);
	await expect(
		reserveImmutableImageDeployment({
			...input,
			expectedImage: divergentSnapshot.dockerImage,
			expectedGeneration: divergentSnapshot.releaseGeneration,
		}),
	).rejects.toThrow("divergent authority");
});
