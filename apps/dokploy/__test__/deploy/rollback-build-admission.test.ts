import { beforeEach, describe, expect, it, vi } from "vitest";

const registryPassword = "fixture-rollback-registry-password";
const admittedLoginCommand = "/private/dokploy-command/registry-login";

const state = vi.hoisted(() => ({
	context: undefined as
		| {
				assertLockHeld: ReturnType<typeof vi.fn>;
				prepareCommand: ReturnType<typeof vi.fn>;
				signal: AbortSignal;
		  }
		| undefined,
	events: [] as string[],
	preparedCommands: [] as string[],
	signal: new AbortController().signal,
}));

const dockerMocks = vi.hoisted(() => ({
	createService: vi.fn(),
	getService: vi.fn(),
	inspect: vi.fn(),
	update: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: { rollbacks: { findFirst: vi.fn() } },
	},
}));

vi.mock("@dokploy/server/db/schema", () => ({
	deployments: { deploymentId: "deployment.deploymentId" },
	rollbacks: { rollbackId: "rollback.rollbackId" },
}));

vi.mock("@dokploy/server/services/application", () => ({
	findApplicationById: vi.fn(),
}));

vi.mock("@dokploy/server/services/deployment", () => ({
	findDeploymentById: vi.fn(),
}));

vi.mock("@dokploy/server/services/network", () => ({
	resolveServiceNetworks: vi.fn(async () => []),
}));

vi.mock("@dokploy/server/services/registry", () => ({
	findRegistryByIdWithCredentials: vi.fn(),
	safeDockerLoginCommand: vi.fn(
		(registryUrl: string, username: string, password: string) =>
			`printf %s '${password}' | docker login '${registryUrl}' -u '${username}' --password-stdin`,
	),
}));

vi.mock("@dokploy/server/utils/cluster/upload", () => ({
	getRegistryTag: vi.fn((_registry: unknown, image: string) => image),
}));

vi.mock("@dokploy/server/utils/docker/utils", () => ({
	calculateResources: vi.fn(() => ({})),
	generateBindMounts: vi.fn(() => []),
	generateConfigContainer: vi.fn(() => ({})),
	generateVolumeMounts: vi.fn(() => []),
	prepareEnvironmentVariables: vi.fn(() => []),
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
				assertLockHeld: vi.fn(),
				prepareCommand: vi.fn(async (command: string) => {
					state.events.push("prepare-login");
					state.preparedCommands.push(command);
					return admittedLoginCommand;
				}),
				signal: state.signal,
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

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(async () => {
		state.events.push("local-login");
		return { stderr: "", stdout: "" };
	}),
	execAsyncRemote: vi.fn(async () => {
		state.events.push("remote-login");
		return { stderr: "", stdout: "" };
	}),
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: vi.fn(async () => {
		state.events.push("docker-client");
		return {
			createService: dockerMocks.createService,
			getService: dockerMocks.getService,
		};
	}),
}));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn(() => ({})),
}));

import { db } from "@dokploy/server/db";
import { findApplicationById } from "@dokploy/server/services/application";
import { findDeploymentById } from "@dokploy/server/services/deployment";
import { safeDockerLoginCommand } from "@dokploy/server/services/registry";
import { rollback } from "@dokploy/server/services/rollbacks";
import { withHostBuildAdmission } from "@dokploy/server/utils/process/build-admission";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { getRemoteDocker } from "@dokploy/server/utils/servers/remote-docker";

const rollbackRegistry = {
	password: registryPassword,
	registryUrl: "registry.example.test",
	username: "fixture-user",
};

const fullContext = {
	command: null,
	cpuLimit: null,
	cpuReservation: null,
	env: "",
	environment: { project: { env: "" } },
	memoryLimit: null,
	memoryReservation: null,
	mounts: [],
	ports: [],
	rollbackRegistry,
};

describe("application rollback build admission", () => {
	beforeEach(() => {
		state.context = undefined;
		state.events.length = 0;
		state.preparedCommands.length = 0;
		vi.clearAllMocks();

		vi.mocked(db.query.rollbacks.findFirst).mockResolvedValue({
			deploymentId: "deployment-id",
			fullContext,
			image: "rollback-image:v1",
		} as never);
		vi.mocked(findDeploymentById).mockResolvedValue({
			applicationId: "application-id",
		} as never);
		dockerMocks.inspect.mockImplementation(async () => {
			state.events.push("service-inspect");
			return {
				Spec: { TaskTemplate: { ForceUpdate: 0 } },
				Version: { Index: "1" },
			};
		});
		dockerMocks.update.mockImplementation(async () => {
			state.events.push("service-update");
		});
		dockerMocks.getService.mockImplementation(() => {
			state.events.push("service-get");
			return { inspect: dockerMocks.inspect, update: dockerMocks.update };
		});
	});

	it.each([
		{ loginEvent: "local-login", serverId: null },
		{ loginEvent: "remote-login", serverId: "remote-server" },
	])(
		"stages a secret-free $loginEvent before the admitted service update",
		async ({ loginEvent, serverId }) => {
			vi.mocked(findApplicationById).mockResolvedValue({
				appName: "fixture-application",
				serverId,
			} as never);

			await rollback("rollback-id");

			expect(withHostBuildAdmission).toHaveBeenCalledWith(
				{ operation: "application-rollback", serverId },
				expect.any(Function),
			);
			expect(safeDockerLoginCommand).toHaveBeenCalledWith(
				rollbackRegistry.registryUrl,
				rollbackRegistry.username,
				registryPassword,
			);
			expect(state.preparedCommands).toHaveLength(1);
			expect(state.preparedCommands[0]).toContain(registryPassword);

			if (serverId) {
				expect(execAsync).not.toHaveBeenCalled();
				expect(execAsyncRemote).toHaveBeenCalledWith(
					serverId,
					admittedLoginCommand,
					undefined,
					state.signal,
				);
			} else {
				expect(execAsyncRemote).not.toHaveBeenCalled();
				expect(execAsync).toHaveBeenCalledWith(admittedLoginCommand, {
					signal: state.signal,
				});
			}

			const outerExecutionCalls = [
				...vi.mocked(execAsync).mock.calls,
				...vi.mocked(execAsyncRemote).mock.calls,
			];
			expect(JSON.stringify(outerExecutionCalls)).not.toContain(
				registryPassword,
			);
			expect(getRemoteDocker).toHaveBeenCalledWith(serverId);
			expect(state.events).toEqual([
				"admission-start",
				"prepare-login",
				loginEvent,
				"docker-client",
				"service-get",
				"service-inspect",
				"service-update",
				"admission-release",
			]);
			expect(dockerMocks.createService).not.toHaveBeenCalled();
		},
	);
});
