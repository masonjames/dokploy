import { createHash } from "node:crypto";
import { db } from "@dokploy/server/db";
import { dbUrl } from "@dokploy/server/db/constants";
import {
	applications,
	type ImmutableReleaseRequestStatus,
	immutableReleaseRequests,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { parse as parseDotEnv } from "dotenv";
import { and, eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";

export type PrepareImmutableApplicationImageInput = {
	applicationId: string;
	expectedOrganizationId: string;
	expectedCurrentImage: string;
	candidateImage: string;
	expectedGeneration: string;
	expectedNonImageConfigHash: string;
};

export type ImmutableApplicationReleaseGuard = {
	idempotencyKey: string;
	organizationId: string;
	expectedImage: string;
	expectedGeneration: string;
	expectedNonImageConfigHash: string;
};

export type ImmutableReleaseReservation = {
	logicalJobId: string;
	physicalJobId: string;
	attempt: number;
	shouldEnqueue: boolean;
	status: ImmutableReleaseRequestStatus;
};

const logicalReleaseJobId = (idempotencyKey: string) =>
	`dockhand-release-${idempotencyKey}`;

const physicalReleaseJobId = (idempotencyKey: string, attempt: number) =>
	`${logicalReleaseJobId(idempotencyKey)}-attempt-${attempt}`;

const assertReleaseRequestBinding = (
	request: typeof immutableReleaseRequests.$inferSelect,
	input: ImmutableApplicationReleaseGuard & {
		applicationId: string;
		organizationId: string;
	},
) => {
	if (
		request.applicationId !== input.applicationId ||
		request.organizationId !== input.organizationId ||
		request.expectedImage !== input.expectedImage ||
		request.expectedGeneration !== input.expectedGeneration ||
		request.expectedNonImageConfigHash !== input.expectedNonImageConfigHash
	) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Immutable release idempotency key names divergent authority",
		});
	}
};

export const reserveImmutableImageDeployment = async (
	input: ImmutableApplicationReleaseGuard & {
		applicationId: string;
		organizationId: string;
	},
): Promise<ImmutableReleaseReservation> =>
	db.transaction(
		async (tx) => {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(20260827)`);
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.applicationId}, 20260827))`,
			);
			const current = await releaseQuery(tx as typeof db, input.applicationId);
			if (!current) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Application not found",
				});
			}
			assertImmutableApplicationReleaseGuard(
				current as unknown as ReleaseApplication,
				input,
			);
			const now = new Date().toISOString();
			const inserted = await tx
				.insert(immutableReleaseRequests)
				.values({
					...input,
					attempt: 1,
					physicalJobId: physicalReleaseJobId(input.idempotencyKey, 1),
					status: "reserved",
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoNothing()
				.returning();
			const existing =
				inserted[0] ??
				(await tx.query.immutableReleaseRequests.findFirst({
					where: eq(
						immutableReleaseRequests.idempotencyKey,
						input.idempotencyKey,
					),
				}));
			if (!existing) {
				throw new TRPCError({
					code: "CONFLICT",
					message: "Immutable release reservation could not be reconciled",
				});
			}
			let request = existing;
			assertReleaseRequestBinding(request, input);
			if (request.status === "error" || request.status === "cancelled") {
				const attempt = request.attempt + 1;
				const retried = await tx
					.update(immutableReleaseRequests)
					.set({
						attempt,
						physicalJobId: physicalReleaseJobId(input.idempotencyKey, attempt),
						status: "reserved",
						updatedAt: now,
					})
					.where(
						and(
							eq(immutableReleaseRequests.idempotencyKey, input.idempotencyKey),
							eq(immutableReleaseRequests.attempt, request.attempt),
							inArray(immutableReleaseRequests.status, ["error", "cancelled"]),
						),
					)
					.returning();
				if (retried[0]) request = retried[0];
			}
			return {
				logicalJobId: logicalReleaseJobId(input.idempotencyKey),
				physicalJobId: request.physicalJobId,
				attempt: request.attempt,
				shouldEnqueue: request.status === "reserved",
				status: request.status,
			};
		},
		{ isolationLevel: "serializable", accessMode: "read write" },
	);

export const markImmutableImageDeploymentQueued = async (
	idempotencyKey: string,
	attempt: number,
) => {
	const now = new Date().toISOString();
	const updated = await db
		.update(immutableReleaseRequests)
		.set({ status: "queued", updatedAt: now })
		.where(
			and(
				eq(immutableReleaseRequests.idempotencyKey, idempotencyKey),
				eq(immutableReleaseRequests.attempt, attempt),
				eq(immutableReleaseRequests.status, "reserved"),
			),
		)
		.returning();
	if (updated[0]) return updated[0];
	const existing = await db.query.immutableReleaseRequests.findFirst({
		where: eq(immutableReleaseRequests.idempotencyKey, idempotencyKey),
	});
	if (!existing || existing.attempt !== attempt) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Immutable release queue reservation changed",
		});
	}
	return existing;
};

export const claimImmutableImageDeployment = async (
	guard: ImmutableApplicationReleaseGuard & {
		attempt: number;
		applicationId: string;
	},
) => {
	const updated = await db
		.update(immutableReleaseRequests)
		.set({ status: "running", updatedAt: new Date().toISOString() })
		.where(
			and(
				eq(immutableReleaseRequests.idempotencyKey, guard.idempotencyKey),
				eq(immutableReleaseRequests.applicationId, guard.applicationId),
				eq(immutableReleaseRequests.organizationId, guard.organizationId),
				eq(immutableReleaseRequests.expectedImage, guard.expectedImage),
				eq(
					immutableReleaseRequests.expectedGeneration,
					guard.expectedGeneration,
				),
				eq(
					immutableReleaseRequests.expectedNonImageConfigHash,
					guard.expectedNonImageConfigHash,
				),
				eq(immutableReleaseRequests.attempt, guard.attempt),
				inArray(immutableReleaseRequests.status, ["reserved", "queued"]),
			),
		)
		.returning();
	return updated.length === 1;
};

export const finishImmutableImageDeployment = async (
	guard: ImmutableApplicationReleaseGuard & {
		attempt: number;
		applicationId: string;
	},
	status: "done" | "error" | "cancelled",
) => {
	const updated = await db
		.update(immutableReleaseRequests)
		.set({ status, updatedAt: new Date().toISOString() })
		.where(
			and(
				eq(immutableReleaseRequests.idempotencyKey, guard.idempotencyKey),
				eq(immutableReleaseRequests.applicationId, guard.applicationId),
				eq(immutableReleaseRequests.organizationId, guard.organizationId),
				eq(immutableReleaseRequests.expectedImage, guard.expectedImage),
				eq(
					immutableReleaseRequests.expectedGeneration,
					guard.expectedGeneration,
				),
				eq(
					immutableReleaseRequests.expectedNonImageConfigHash,
					guard.expectedNonImageConfigHash,
				),
				eq(immutableReleaseRequests.attempt, guard.attempt),
				eq(immutableReleaseRequests.status, "running"),
			),
		)
		.returning();
	if (updated.length !== 1) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Immutable release completion differs from durable reservation",
		});
	}
};

export const reconcileInterruptedImmutableImageDeployments = async () => {
	const reconciled = await db
		.update(immutableReleaseRequests)
		.set({ status: "error", updatedAt: new Date().toISOString() })
		.where(
			inArray(immutableReleaseRequests.status, [
				"reserved",
				"queued",
				"running",
			]),
		)
		.returning({ idempotencyKey: immutableReleaseRequests.idempotencyKey });
	return reconciled.length;
};

const IMMUTABLE_RELEASE_WORKER_LOCK = 2026082701;
type ImmutableReleaseWorkerLease = {
	client?: ReturnType<typeof postgres>;
	acquisition?: Promise<number>;
};
const globalForImmutableReleaseWorker = globalThis as unknown as {
	__dokployImmutableReleaseWorkerLease?: ImmutableReleaseWorkerLease;
};
globalForImmutableReleaseWorker.__dokployImmutableReleaseWorkerLease ??= {};

/**
 * Own the one immutable-release worker before reconciling lost in-memory jobs.
 * PostgreSQL releases the session lock when the process or dedicated
 * connection dies, so a replacement can reconcile only after the old worker
 * can no longer mutate the target.
 */
export const acquireImmutableReleaseWorkerLease = async () => {
	const state =
		globalForImmutableReleaseWorker.__dokployImmutableReleaseWorkerLease!;
	state.acquisition ??= (async () => {
		let ownsLease = false;
		const client = postgres(dbUrl, {
			max: 1,
			max_lifetime: null,
			onclose: () => {
				if (ownsLease) process.exit(1);
			},
		});
		try {
			const [lease] = await client<[{ acquired: boolean }]>`
				SELECT pg_try_advisory_lock(${IMMUTABLE_RELEASE_WORKER_LOCK}) AS acquired
			`;
			if (!lease?.acquired) {
				throw new TRPCError({
					code: "CONFLICT",
					message: "Immutable release worker lease is already held",
				});
			}
			ownsLease = true;
			state.client = client;
			return await reconcileInterruptedImmutableImageDeployments();
		} catch (error) {
			ownsLease = false;
			await client.end();
			throw error;
		}
	})();
	return state.acquisition;
};

const IMMUTABLE_IMAGE_RE = /@sha256:[a-f0-9]{64}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };
type ReleaseApplication = Record<string, unknown>;

const canonicalize = (value: unknown): JsonValue => {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new Error("Non-finite release configuration number");
		return value;
	}
	if (typeof value === "bigint") return value.toString();
	if (Array.isArray(value)) return value.map(canonicalize);
	if (typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, canonicalize(item)]),
		);
	}
	throw new Error("Noncanonical release configuration value");
};

const sha256 = (value: unknown) =>
	createHash("sha256")
		.update(JSON.stringify(canonicalize(value)))
		.digest("hex");

const selectedList = (
	value: unknown,
	fields: readonly string[],
): Array<Record<string, JsonValue>> => {
	if (!Array.isArray(value)) return [];
	return value
		.filter(
			(item): item is Record<string, unknown> =>
				item !== null && typeof item === "object",
		)
		.map((item) =>
			Object.fromEntries(
				fields
					.filter((field) => field in item)
					.map((field) => [field, canonicalize(item[field])]),
			),
		)
		.sort((left, right) => sha256(left).localeCompare(sha256(right)));
};

const ENVIRONMENT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const selectedEnvironmentNames = (...values: unknown[]): string[] =>
	Array.from(
		new Set(
			values.flatMap((value) =>
				typeof value === "string" ? Object.keys(parseDotEnv(value)) : [],
			),
		),
	)
		.filter((name) => ENVIRONMENT_NAME_RE.test(name))
		.sort();

/**
 * Secret-free release projection. The database-managed revision changes for
 * every application, environment, project, mount, port, or domain mutation,
 * so arbitrary configuration values never need to enter evidence or hashes.
 */
export const normalizeImmutableApplicationReleaseConfig = (
	application: ReleaseApplication,
) => ({
	applicationId: application.applicationId ?? null,
	releaseConfigRevision: application.releaseConfigRevision ?? null,
	sourceType: application.sourceType ?? null,
	environmentId: application.environmentId ?? null,
	projectId:
		(application.environment as { project?: { projectId?: string } })?.project
			?.projectId ?? null,
	registryId: application.registryId ?? null,
	rollbackRegistryId: application.rollbackRegistryId ?? null,
	serverId: application.serverId ?? null,
	buildServerId: application.buildServerId ?? null,
	buildRegistryId: application.buildRegistryId ?? null,
	replicas: application.replicas ?? null,
	portCount: Array.isArray(application.ports) ? application.ports.length : 0,
	mountCount: Array.isArray(application.mounts) ? application.mounts.length : 0,
	domainCount: Array.isArray(application.domains)
		? application.domains.length
		: 0,
	networkCount: Array.isArray(application.networkIds)
		? application.networkIds.length
		: 0,
});

export const immutableApplicationReleaseSnapshot = (
	application: ReleaseApplication,
) => {
	const applicationId = application.applicationId;
	const dockerImage = application.dockerImage;
	if (typeof applicationId !== "string" || typeof dockerImage !== "string") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Application image is not configured",
		});
	}
	if (
		application.serverId != null ||
		application.buildServerId != null ||
		application.registryId != null ||
		application.buildRegistryId != null ||
		application.rollbackRegistryId != null
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Immutable image deployment requires a local target without registry indirection",
		});
	}
	const nonImageConfig =
		normalizeImmutableApplicationReleaseConfig(application);
	const nonImageConfigHash = sha256(nonImageConfig);
	const environment = application.environment as
		| { env?: unknown; project?: { env?: unknown } }
		| undefined;
	return {
		applicationId,
		sourceType: "docker" as const,
		dockerImage,
		releaseGeneration: sha256({
			applicationId,
			dockerImage,
			nonImageConfigHash,
		}),
		nonImageConfigHash,
		nonImageConfig,
		environmentNames: selectedEnvironmentNames(
			application.env,
			environment?.env,
			environment?.project?.env,
		),
		applicationStatus:
			typeof application.applicationStatus === "string"
				? application.applicationStatus
				: "unknown",
		deployments: selectedList(application.deployments, [
			"deploymentId",
			"title",
			"status",
			"createdAt",
			"startedAt",
			"finishedAt",
		]),
	};
};

export const assertImmutableApplicationReleaseGuard = (
	application: ReleaseApplication,
	guard: ImmutableApplicationReleaseGuard,
) => {
	const snapshot = immutableApplicationReleaseSnapshot(application);
	if (
		(
			application.environment as {
				project?: { organizationId?: string };
			}
		)?.project?.organizationId !== guard.organizationId ||
		snapshot.dockerImage !== guard.expectedImage ||
		snapshot.releaseGeneration !== guard.expectedGeneration ||
		snapshot.nonImageConfigHash !== guard.expectedNonImageConfigHash
	) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Application release generation changed before worker execution",
		});
	}
	return snapshot;
};

const releaseQuery = (executor: typeof db, applicationId: string) =>
	executor.query.applications.findFirst({
		where: eq(applications.applicationId, applicationId),
		with: {
			ports: true,
			mounts: true,
			domains: true,
			deployments: true,
			environment: { with: { project: true } },
		},
	});

export const getImmutableApplicationReleaseSnapshot = async (
	applicationId: string,
) => {
	const application = await releaseQuery(db, applicationId);
	if (!application)
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Application not found",
		});
	if (application.sourceType !== "docker") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Immutable image preparation requires a Docker provider application",
		});
	}
	const snapshot = immutableApplicationReleaseSnapshot(
		application as unknown as ReleaseApplication,
	);
	const requests = await db.query.immutableReleaseRequests.findMany({
		where: eq(immutableReleaseRequests.applicationId, applicationId),
	});
	return {
		...snapshot,
		deployments: requests
			.map((request) => ({
				deploymentId: logicalReleaseJobId(request.idempotencyKey),
				title: `Dockhand governed release ${request.idempotencyKey}`,
				status:
					request.status === "reserved" || request.status === "queued"
						? "running"
						: request.status,
				createdAt: request.createdAt,
				startedAt: request.status === "running" ? request.updatedAt : null,
				finishedAt: ["done", "error", "cancelled"].includes(request.status)
					? request.updatedAt
					: null,
			}))
			.sort((left, right) =>
				left.deploymentId.localeCompare(right.deploymentId),
			),
	};
};

/** Serializable compare-and-swap that writes only dockerImage. */
export const prepareImmutableApplicationImage = async ({
	applicationId,
	expectedOrganizationId,
	expectedCurrentImage,
	candidateImage,
	expectedGeneration,
	expectedNonImageConfigHash,
}: PrepareImmutableApplicationImageInput) => {
	if (!IMMUTABLE_IMAGE_RE.test(candidateImage)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "candidateImage must be pinned by sha256 digest",
		});
	}
	if (
		!SHA256_RE.test(expectedGeneration) ||
		!SHA256_RE.test(expectedNonImageConfigHash)
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "release generation hashes are invalid",
		});
	}

	return db.transaction(
		async (tx) => {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(20260827)`);
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtextextended(${applicationId}, 20260827))`,
			);
			const current = await releaseQuery(tx as typeof db, applicationId);
			if (!current)
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Application not found",
				});
			if (current.sourceType !== "docker") {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"Immutable image preparation requires a Docker provider application",
				});
			}
			if (
				current.environment.project.organizationId !== expectedOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this application",
				});
			}
			const before = immutableApplicationReleaseSnapshot(
				current as unknown as ReleaseApplication,
			);
			if (
				before.dockerImage !== expectedCurrentImage ||
				before.releaseGeneration !== expectedGeneration ||
				before.nonImageConfigHash !== expectedNonImageConfigHash
			) {
				throw new TRPCError({
					code: "CONFLICT",
					message:
						"Application release generation changed before image preparation",
				});
			}
			await tx.execute(
				sql`SELECT set_config('dockhand.internal_image_cas', '1', true)`,
			);
			const updated = await tx
				.update(applications)
				.set({ dockerImage: candidateImage })
				.where(
					and(
						eq(applications.applicationId, applicationId),
						eq(applications.sourceType, "docker"),
						eq(applications.dockerImage, expectedCurrentImage),
					),
				)
				.returning({ applicationId: applications.applicationId });
			await tx.execute(
				sql`SELECT set_config('dockhand.internal_image_cas', '0', true)`,
			);
			if (updated.length !== 1) {
				throw new TRPCError({
					code: "CONFLICT",
					message: "Application image changed before preparation",
				});
			}
			const after = await releaseQuery(tx as typeof db, applicationId);
			if (!after) {
				throw new TRPCError({
					code: "CONFLICT",
					message: "Application disappeared during image preparation",
				});
			}
			return {
				applicationId,
				previous: before,
				current: immutableApplicationReleaseSnapshot(
					after as unknown as ReleaseApplication,
				),
			};
		},
		{ isolationLevel: "serializable", accessMode: "read write" },
	);
};
