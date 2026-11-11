import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	assertTraefikProvider: vi.fn(),
	findServerById: vi.fn(),
	serverSetup: vi.fn(),
}));
vi.mock("@dokploy/server", () => ({ IS_CLOUD: false, ...mocks }));
vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));
vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(),
}));
vi.mock("@/pages/api/stripe/webhook", () => ({
	updateServersBasedOnQuantity: vi.fn(),
}));
vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));
vi.mock("@/server/utils/docker-cleanup", () => ({
	applyDockerCleanupSchedule: vi.fn(),
}));
const { serverRouter } = await import("@/server/api/routers/server");
const caller = serverRouter.createCaller({
	session: { activeOrganizationId: "org-a" },
	user: { id: "admin", role: "admin" },
} as Parameters<typeof serverRouter.createCaller>[0]);

beforeEach(() => {
	vi.resetAllMocks();
	mocks.findServerById.mockResolvedValue({
		serverId: "server-1",
		organizationId: "org-a",
	});
});

it.each(["setup", "setupWithLogs"] as const)(
	"%s refuses Caddy before setup starts",
	async (procedure) => {
		mocks.assertTraefikProvider.mockRejectedValue(
			new Error("This server runs Caddy"),
		);
		await expect(caller[procedure]({ serverId: "server-1" })).rejects.toThrow(
			"This server runs Caddy",
		);
		expect(mocks.serverSetup).not.toHaveBeenCalled();
	},
);

it("delivers an asynchronous setup rejection to the subscription and closes it", async () => {
	const failure = new Error(
		"Server setup installs Traefik and cannot run on a Caddy server",
	);
	mocks.serverSetup.mockRejectedValue(failure);
	const stream = await caller.setupWithLogs({ serverId: "server-1" });
	const error = vi.fn();
	const next = vi.fn();
	stream.subscribe({ error, next });
	await vi.waitFor(() => expect(error).toHaveBeenCalledWith(failure));
	expect(error).toHaveBeenCalledOnce();
	expect(next).not.toHaveBeenCalled();
});

it("streams setup output and completes on success", async () => {
	mocks.serverSetup.mockImplementation(
		async (_id: string, onData: (log: string) => void) => onData("done"),
	);
	const stream = await caller.setupWithLogs({ serverId: "server-1" });
	const next = vi.fn();
	const complete = vi.fn();
	stream.subscribe({ next, complete });
	await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
	expect(next).toHaveBeenCalledWith("done");
});
