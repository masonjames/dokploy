import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getWebServerProvider: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));
vi.mock("@dokploy/server/services/application", async (original) => ({
	...(await original<typeof import("@dokploy/server/services/application")>()),
	findApplicationById: vi.fn(async () => ({
		serverId: "source",
		environment: { project: { organizationId: "org" } },
	})),
}));
vi.mock("@dokploy/server/services/server", async (original) => ({
	...(await original<typeof import("@dokploy/server/services/server")>()),
	findServerById: vi.fn(async () => ({
		organizationId: "org",
		serverStatus: "active",
		serverType: "deploy",
	})),
}));
vi.mock("@dokploy/server/services/web-server-settings", async (original) => ({
	...(await original<
		typeof import("@dokploy/server/services/web-server-settings")
	>()),
	getWebServerProvider: mocks.getWebServerProvider,
}));
vi.mock("@dokploy/server/utils/process/execAsync", async (original) => ({
	...(await original<
		typeof import("@dokploy/server/utils/process/execAsync")
	>()),
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));
const { transferService } = await import("@dokploy/server/services/transfer");
beforeEach(() => vi.clearAllMocks());
it.each(["source", "target"])(
	"refuses a Caddy %s before transferring anything",
	async (caddyServer) => {
		mocks.getWebServerProvider.mockImplementation(async (id: string) =>
			id === caddyServer ? "caddy" : "traefik",
		);
		const log = vi.fn();
		await expect(
			transferService(
				{
					serviceType: "application",
					serviceId: "app",
					targetServerId: "target",
					organizationId: "org",
					removeSourceData: false,
				},
				log,
			),
		).rejects.toThrow("not supported to or from a Caddy server");
		expect(log).not.toHaveBeenCalled();
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	},
);
