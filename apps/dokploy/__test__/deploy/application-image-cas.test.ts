import { beforeEach, expect, test, vi } from "vitest";

const {
	dbMock,
	transactionMock,
	updateMock,
	setMock,
	whereMock,
	returningMock,
	findFirstMock,
} = vi.hoisted(() => {
	const transactionMock = vi.fn();
	const updateMock = vi.fn();
	const setMock = vi.fn();
	const whereMock = vi.fn();
	const returningMock = vi.fn();
	const findFirstMock = vi.fn();
	return {
		dbMock: {
			execute: vi.fn(),
			transaction: transactionMock,
			update: updateMock,
			query: { applications: { findFirst: findFirstMock } },
		},
		transactionMock,
		updateMock,
		setMock,
		whereMock,
		returningMock,
		findFirstMock,
	};
});

vi.mock("@dokploy/server/db", () => ({ db: dbMock }));

import { apiUpdateApplication } from "@dokploy/server/db/schema";
import {
	immutableApplicationReleaseSnapshot,
	normalizeImmutableApplicationReleaseConfig,
	prepareImmutableApplicationImage,
} from "@dokploy/server/services/application-image";

const digestImage = `ghcr.io/example/app@sha256:${"a".repeat(64)}`;
const currentImage = `ghcr.io/example/app@sha256:${"b".repeat(64)}`;
const application = {
	applicationId: "app-1",
	releaseConfigRevision: 7,
	appName: "example-app",
	dockerImage: currentImage,
	sourceType: "docker",
	environmentId: "env-1",
	registryUrl: "ghcr.io",
	serverId: null,
	buildServerId: null,
	buildRegistryId: null,
	username: "robot",
	password: "must-never-escape",
	env: "PUBLIC_FLAG=false\nSECRET_TOKEN=must-never-escape",
	command: "/app/bin/agent",
	args: ["serve", "--fixed"],
	replicas: 1,
	labelsSwarm: { "release.lane": "fixed" },
	healthCheckSwarm: { test: ["CMD", "/app/bin/health"] },
	ports: [
		{
			portId: "port-1",
			publishedPort: 18789,
			targetPort: 18789,
			protocol: "tcp",
		},
	],
	mounts: [
		{
			mountId: "mount-1",
			type: "file",
			filePath: "/run/secrets/token",
			mountPath: "/run/token",
			content: "must-never-enter-a-hash",
		},
	],
	domains: [],
	deployments: [],
	applicationStatus: "done",
	environment: {
		env: "ENVIRONMENT_FLAG=environment-secret\nSHARED_FLAG=environment",
		project: {
			projectId: "project-1",
			organizationId: "org-1",
			env: "PROJECT_FLAG=project-secret\nSHARED_FLAG=project",
		},
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	transactionMock.mockImplementation(async (callback) => callback(dbMock));
	updateMock.mockReturnValue({ set: setMock });
	setMock.mockReturnValue({ where: whereMock });
	whereMock.mockReturnValue({ returning: returningMock });
	findFirstMock.mockResolvedValueOnce(application).mockResolvedValueOnce({
		...application,
		dockerImage: digestImage,
		releaseConfigRevision: 7,
	});
	returningMock.mockResolvedValue([{ applicationId: "app-1" }]);
});

test("serializably changes only dockerImage under exact release generation", async () => {
	const before = immutableApplicationReleaseSnapshot(application);
	const result = await prepareImmutableApplicationImage({
		applicationId: "app-1",
		expectedOrganizationId: "org-1",
		expectedCurrentImage: currentImage,
		candidateImage: digestImage,
		expectedGeneration: before.releaseGeneration,
		expectedNonImageConfigHash: before.nonImageConfigHash,
	});

	expect(transactionMock).toHaveBeenCalledWith(expect.any(Function), {
		isolationLevel: "serializable",
		accessMode: "read write",
	});
	expect(setMock).toHaveBeenCalledWith({ dockerImage: digestImage });
	expect(dbMock.execute).toHaveBeenCalledTimes(4);
	expect(dbMock.execute.mock.invocationCallOrder[2]).toBeLessThan(
		updateMock.mock.invocationCallOrder[0]!,
	);
	expect(dbMock.execute.mock.invocationCallOrder[3]).toBeGreaterThan(
		returningMock.mock.invocationCallOrder[0]!,
	);
	expect(result.previous).toEqual(before);
	expect(result.current.dockerImage).toBe(digestImage);
	expect(result.current.nonImageConfigHash).toBe(before.nonImageConfigHash);
	expect(JSON.stringify(result)).not.toContain("must-never-escape");
});

test("rejects stale release generation before touching the image row", async () => {
	const before = immutableApplicationReleaseSnapshot(application);
	await expect(
		prepareImmutableApplicationImage({
			applicationId: "app-1",
			expectedOrganizationId: "org-1",
			expectedCurrentImage: currentImage,
			candidateImage: digestImage,
			expectedGeneration: "9".repeat(64),
			expectedNonImageConfigHash: before.nonImageConfigHash,
		}),
	).rejects.toMatchObject({ code: "CONFLICT" });
	expect(updateMock).not.toHaveBeenCalled();
});

test("binds arbitrary configuration through its revision without hashing values", () => {
	const baseline = immutableApplicationReleaseSnapshot(application);
	expect(baseline.nonImageConfig).toEqual(
		normalizeImmutableApplicationReleaseConfig(application),
	);
	const hostileCommandApplication = {
		...application,
		command: "must-never-escape command",
	};
	const hostileCommand = immutableApplicationReleaseSnapshot(
		hostileCommandApplication,
	);
	const changedSecrets = immutableApplicationReleaseSnapshot({
		...application,
		env: "PUBLIC_FLAG=true\nSECRET_TOKEN=different",
		password: "different",
		mounts: [{ ...application.mounts[0], content: "different" }],
	});
	expect(hostileCommand.nonImageConfigHash).toBe(baseline.nonImageConfigHash);
	expect(changedSecrets.nonImageConfigHash).toBe(baseline.nonImageConfigHash);
	const changedSecretRevision = immutableApplicationReleaseSnapshot({
		...changedSecrets,
		releaseConfigRevision: application.releaseConfigRevision + 1,
	});
	expect(changedSecretRevision.nonImageConfigHash).not.toBe(
		baseline.nonImageConfigHash,
	);
	expect(
		JSON.stringify({
			baseline: normalizeImmutableApplicationReleaseConfig(application),
			hostileCommand: normalizeImmutableApplicationReleaseConfig(
				hostileCommandApplication,
			),
			changedSecrets:
				normalizeImmutableApplicationReleaseConfig(changedSecrets),
		}),
	).not.toContain("must-never-escape");
});

test("projects sorted environment names without exposing any values", () => {
	const snapshot = immutableApplicationReleaseSnapshot(application);
	expect(snapshot.environmentNames).toEqual([
		"ENVIRONMENT_FLAG",
		"PROJECT_FLAG",
		"PUBLIC_FLAG",
		"SECRET_TOKEN",
		"SHARED_FLAG",
	]);
	const wire = JSON.stringify(snapshot);
	for (const secretValue of [
		"environment-secret",
		"project-secret",
		"must-never-escape",
	]) {
		expect(wire).not.toContain(secretValue);
	}
});

test("rejects remote-server and mutable registry routing", () => {
	for (const changed of [
		{ ...application, serverId: "server-2" },
		{ ...application, buildServerId: "builder-2" },
		{ ...application, registryId: "registry-1" },
		{ ...application, buildRegistryId: "registry-2" },
		{ ...application, rollbackRegistryId: "registry-3" },
	]) {
		expect(() => immutableApplicationReleaseSnapshot(changed)).toThrow(
			"requires a local target without registry indirection",
		);
	}
});

test("rejects targets with caller-managed routes", () => {
	expect(() =>
		immutableApplicationReleaseSnapshot({
			...application,
			domains: [{ domainId: "route-1", host: "hostile.example" }],
		}),
	).toThrow("requires a target without routes");
});

test("does not accept the database-managed release revision from clients", () => {
	const parsed = apiUpdateApplication.parse({
		applicationId: "app-1",
		releaseConfigRevision: 1,
	});
	expect(parsed).not.toHaveProperty("releaseConfigRevision");
});

test("binds environment and project assignment", () => {
	const baseline = immutableApplicationReleaseSnapshot(application);
	for (const changed of [
		{ ...application, environmentId: "env-2" },
		{
			...application,
			environment: {
				project: { projectId: "project-2", organizationId: "org-1" },
			},
		},
	]) {
		expect(
			immutableApplicationReleaseSnapshot(changed).nonImageConfigHash,
		).not.toBe(baseline.nonImageConfigHash);
	}
});

test("rejects a mutable candidate before opening a transaction", async () => {
	const before = immutableApplicationReleaseSnapshot(application);
	await expect(
		prepareImmutableApplicationImage({
			applicationId: "app-1",
			expectedOrganizationId: "org-1",
			expectedCurrentImage: currentImage,
			candidateImage: "ghcr.io/example/app:sha-new",
			expectedGeneration: before.releaseGeneration,
			expectedNonImageConfigHash: before.nonImageConfigHash,
		}),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
	expect(transactionMock).not.toHaveBeenCalled();
});

test("rejects a tenant change inside the serializable image transaction", async () => {
	const before = immutableApplicationReleaseSnapshot(application);
	await expect(
		prepareImmutableApplicationImage({
			applicationId: "app-1",
			expectedOrganizationId: "org-2",
			expectedCurrentImage: currentImage,
			candidateImage: digestImage,
			expectedGeneration: before.releaseGeneration,
			expectedNonImageConfigHash: before.nonImageConfigHash,
		}),
	).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	expect(updateMock).not.toHaveBeenCalled();
});
