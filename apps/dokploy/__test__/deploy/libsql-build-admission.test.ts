import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	assertionCount: 0,
	context: undefined as
		| {
				assertLockHeld: () => void;
				prepareCommand: (command: string) => Promise<string>;
				signal: AbortSignal;
		  }
		| undefined,
	events: [] as string[],
	lockHeld: true,
	loseLockOnAssertion: null as number | null,
	statuses: [] as string[],
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: { libsql: { findFirst: vi.fn() } },
		update: vi.fn(),
	},
}));

vi.mock("@dokploy/server/db/schema", () => ({
	backups: { libsqlId: "backups.libsqlId" },
	buildAppName: vi.fn((_type: string, appName: string) => appName),
	libsql: { libsqlId: "libsql.libsqlId" },
}));

vi.mock("@dokploy/server/templates", () => ({
	generatePassword: vi.fn(() => "fixture-password"),
}));

vi.mock("@dokploy/server/services/network", () => ({
	resolveServiceNetworks: vi.fn().mockResolvedValue([]),
}));

vi.mock("@dokploy/server/services/project", () => ({
	validUniqueServerAppName: vi.fn().mockResolvedValue(true),
}));

vi.mock("@dokploy/server/utils/docker/utils", () => ({
	calculateResources: vi.fn(() => ({})),
	generateBindMounts: vi.fn(() => []),
	generateConfigContainer: vi.fn(() => ({})),
	generateFileMounts: vi.fn(() => []),
	generateVolumeMounts: vi.fn(() => []),
	prepareEnvironmentVariables: vi.fn(() => []),
	pullImageUnderBuildAdmission: vi.fn(
		async ({ context }: { context: typeof state.context }) => {
			expect(context).toBe(state.context);
			context?.assertLockHeld();
			state.events.push("pull");
			context?.assertLockHeld();
		},
	),
	waitForSwarmServiceConvergence: vi.fn(async () => {
		state.events.push("convergence");
	}),
}));

vi.mock("@dokploy/server/utils/process/build-admission", () => ({
	withHostBuildAdmission: vi.fn(
		async (
			_options: unknown,
			callback: (
				context: NonNullable<typeof state.context>,
			) => Promise<unknown>,
		) => {
			state.events.push("admission-start");
			const context = {
				assertLockHeld: () => {
					state.assertionCount += 1;
					if (state.assertionCount === state.loseLockOnAssertion) {
						state.lockHeld = false;
					}
					if (!state.lockHeld) {
						throw new Error("fixture host build lock lost");
					}
				},
				prepareCommand: async (command: string) => command,
				signal: new AbortController().signal,
			};
			state.context = context;
			try {
				return await callback(context);
			} finally {
				state.events.push("admission-release");
			}
		},
	),
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn(() => ({})),
	getTableColumns: vi.fn(() => ({})),
}));

import { db } from "@dokploy/server/db";
import { deployLibsql } from "@dokploy/server/services/libsql";
import {
	pullImageUnderBuildAdmission,
	waitForSwarmServiceConvergence,
} from "@dokploy/server/utils/docker/utils";
import { withHostBuildAdmission } from "@dokploy/server/utils/process/build-admission";
import { getRemoteDocker } from "@dokploy/server/utils/servers/remote-docker";

const fixture = {
	appName: "libsql-fixture",
	command: null,
	cpuLimit: null,
	cpuReservation: null,
	databasePassword: "fixture-password",
	databaseUser: "fixture-user",
	dockerImage: "ghcr.io/tursodatabase/libsql-server:v0.24.32",
	enableNamespaces: false,
	env: "",
	environment: {
		env: "",
		project: { env: "", organizationId: "organization-id" },
	},
	externalAdminPort: null,
	externalGRPCPort: null,
	externalPort: null,
	libsqlId: "libsql-id",
	memoryLimit: null,
	memoryReservation: null,
	mounts: [],
	serverId: null,
	sqldNode: "primary",
	sqldPrimaryUrl: null,
};

const serviceInspect = vi.fn(async () => {
	state.events.push("service-inspect");
	return { Version: { Index: "1" } };
});
const serviceUpdate = vi.fn(async () => {
	state.events.push("service-update");
});
const getService = vi.fn(() => {
	state.events.push("service-get");
	return { inspect: serviceInspect, update: serviceUpdate };
});
const createService = vi.fn(async () => {
	state.events.push("service-create");
});

describe("LibSQL host build admission", () => {
	beforeEach(() => {
		state.assertionCount = 0;
		state.context = undefined;
		state.events.length = 0;
		state.lockHeld = true;
		state.loseLockOnAssertion = null;
		state.statuses.length = 0;
		vi.clearAllMocks();

		const updateChain = {
			returning: vi.fn(async () => [fixture]),
			set: vi.fn((values: { applicationStatus?: string }) => {
				if (values.applicationStatus) {
					state.statuses.push(values.applicationStatus);
				}
				return updateChain;
			}),
			where: vi.fn(() => updateChain),
		};
		vi.mocked(db.query.libsql.findFirst).mockResolvedValue(fixture as never);
		vi.mocked(db.update).mockReturnValue(updateChain as never);
		vi.mocked(getRemoteDocker).mockResolvedValue({
			createService,
			getService,
		} as never);
	});

	it("holds one admission callback across the image pull and service update", async () => {
		await expect(deployLibsql("libsql-id")).resolves.toBe(fixture);

		expect(withHostBuildAdmission).toHaveBeenCalledTimes(1);
		expect(withHostBuildAdmission).toHaveBeenCalledWith(
			{ operation: "libsql-deploy", serverId: null },
			expect.any(Function),
		);
		expect(pullImageUnderBuildAdmission).toHaveBeenCalledWith(
			expect.objectContaining({
				context: state.context,
				dockerImage: fixture.dockerImage,
				serverId: null,
			}),
		);
		expect(waitForSwarmServiceConvergence).toHaveBeenCalledWith(
			fixture.appName,
			fixture.serverId,
		);
		expect(state.events).toEqual([
			"admission-start",
			"pull",
			"service-get",
			"service-inspect",
			"service-update",
			"admission-release",
			"convergence",
		]);
		expect(state.statuses).toEqual(["running", "done"]);
		expect(createService).not.toHaveBeenCalled();
	});

	it("does not mutate the Docker service after ownership is lost", async () => {
		state.loseLockOnAssertion = 4;

		await expect(deployLibsql("libsql-id")).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
		});

		expect(state.events).toEqual([
			"admission-start",
			"pull",
			"service-get",
			"service-inspect",
			"admission-release",
		]);
		expect(serviceUpdate).not.toHaveBeenCalled();
		expect(createService).not.toHaveBeenCalled();
		expect(state.statuses).toEqual(["running", "error"]);
	});
});
