import type { BuildAdmissionContext } from "@dokploy/server/utils/process/build-admission";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dockerMocks = vi.hoisted(() => ({
	createService: vi.fn(async () => undefined),
	getService: vi.fn(),
	inspect: vi.fn(),
	update: vi.fn(),
}));

vi.mock("@dokploy/server/services/network", () => ({
	resolveServiceNetworks: vi.fn(async () => []),
}));

vi.mock("@dokploy/server/utils/docker/utils", () => ({
	calculateResources: vi.fn(() => ({})),
	generateBindMounts: vi.fn(() => []),
	generateConfigContainer: vi.fn(() => ({})),
	generateFileMounts: vi.fn(() => []),
	generateVolumeMounts: vi.fn(() => []),
	prepareEnvironmentVariables: vi.fn(() => []),
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: vi.fn(async () => ({
		createService: dockerMocks.createService,
		getService: dockerMocks.getService,
	})),
}));

import { buildMariadb } from "@dokploy/server/utils/databases/mariadb";
import { buildMongo } from "@dokploy/server/utils/databases/mongo";
import { buildMysql } from "@dokploy/server/utils/databases/mysql";
import { buildPostgres } from "@dokploy/server/utils/databases/postgres";
import { buildRedis } from "@dokploy/server/utils/databases/redis";

const fixture = {
	appName: "database-fixture",
	args: [],
	command: null,
	cpuLimit: null,
	cpuReservation: null,
	databaseName: "fixture-db",
	databasePassword: "fixture-password",
	databaseRootPassword: "fixture-root-password",
	databaseUser: "fixture-user",
	dockerImage: "fixture/database:1.0.0",
	env: "",
	environment: { env: "", project: { env: "" } },
	externalPort: null,
	memoryLimit: null,
	memoryReservation: null,
	mounts: [],
	replicaSets: false,
	serverId: null,
	updateConfigSwarm: null,
};

const builders = [
	["Postgres", buildPostgres],
	["MySQL", buildMysql],
	["MariaDB", buildMariadb],
	["MongoDB", buildMongo],
	["Redis", buildRedis],
] as const;

describe("database service build admission", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		dockerMocks.inspect.mockResolvedValue({
			Spec: { TaskTemplate: { ForceUpdate: 0 } },
			Version: { Index: "1" },
		});
		dockerMocks.getService.mockReturnValue({
			inspect: dockerMocks.inspect,
			update: dockerMocks.update,
		});
	});

	it.each(builders)(
		"does not let %s fall back to createService after lock loss",
		async (_name, build) => {
			const lockLoss = new Error("fixture host build lock lost");
			let lockLost = false;
			dockerMocks.update.mockImplementation(async () => {
				lockLost = true;
				throw new Error("fixture service update interrupted");
			});
			const context: BuildAdmissionContext = {
				assertLockHeld: () => {
					if (lockLost) throw lockLoss;
				},
				prepareCommand: vi.fn(async (command: string) => command),
				signal: new AbortController().signal,
			};

			await expect(build(fixture as never, context)).rejects.toBe(lockLoss);

			expect(dockerMocks.update).toHaveBeenCalledOnce();
			expect(dockerMocks.createService).not.toHaveBeenCalled();
		},
	);
});
