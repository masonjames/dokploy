import { reconnectServicesToTraefik } from "@dokploy/server/services/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	withHostBuildAdmission: vi.fn(),
	signal: new AbortController().signal,
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			compose: {
				findMany: mocks.findMany,
			},
		},
	},
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

vi.mock("@dokploy/server/utils/process/build-admission", () => ({
	withHostBuildAdmission: mocks.withHostBuildAdmission,
}));

describe("reconnectServicesToTraefik", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findMany.mockResolvedValue([]);
		mocks.withHostBuildAdmission.mockImplementation((_options, callback) =>
			callback({
				prepareCommand: async (command: string) => command,
				signal: mocks.signal,
			}),
		);
	});

	it("does not execute an empty local command when no isolated deployments exist", async () => {
		await reconnectServicesToTraefik();

		expect(mocks.withHostBuildAdmission).not.toHaveBeenCalled();
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("does not execute an empty remote command when no isolated deployments exist", async () => {
		await reconnectServicesToTraefik("server-id");

		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("reconnects isolated deployments to the local Traefik network", async () => {
		mocks.findMany.mockResolvedValue([
			{ appName: "first-compose" },
			{ appName: "second-compose" },
		]);

		await reconnectServicesToTraefik();

		expect(mocks.withHostBuildAdmission).toHaveBeenCalledWith(
			{ serverId: null, operation: "dokploy-traefik-network-reconnect" },
			expect.any(Function),
		);
		expect(mocks.execAsync).toHaveBeenCalledOnce();
		expect(mocks.execAsync).toHaveBeenCalledWith(
			'docker network connect first-compose $(docker ps --filter "name=dokploy-traefik" -q) >/dev/null 2>&1\n' +
				'docker network connect second-compose $(docker ps --filter "name=dokploy-traefik" -q) >/dev/null 2>&1\n',
			{ signal: mocks.signal },
		);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("reconnects isolated deployments on a remote server", async () => {
		mocks.findMany.mockResolvedValue([{ appName: "remote-compose" }]);

		await reconnectServicesToTraefik("server-id");

		expect(mocks.execAsyncRemote).toHaveBeenCalledOnce();
		expect(mocks.withHostBuildAdmission).toHaveBeenCalledWith(
			{ serverId: "server-id", operation: "dokploy-traefik-network-reconnect" },
			expect.any(Function),
		);
		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"server-id",
			'docker network connect remote-compose $(docker ps --filter "name=dokploy-traefik" -q) >/dev/null 2>&1\n',
			undefined,
			mocks.signal,
		);
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});
});
