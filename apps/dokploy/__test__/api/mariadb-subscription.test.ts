import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ deployMariadb: vi.fn() }));
vi.mock("@dokploy/server", () => ({ IS_CLOUD: false, ...mocks }));
vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));
vi.mock("@dokploy/server/services/permission", () => ({
	checkServicePermissionAndAccess: vi.fn(),
}));
vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));
vi.mock("@/server/utils/backup", () => ({ cancelJobs: vi.fn() }));
const { mariadbRouter } = await import("@/server/api/routers/mariadb");
const caller = mariadbRouter.createCaller({
	session: { activeOrganizationId: "org-a" },
	user: { id: "admin", role: "admin" },
} as Parameters<typeof mariadbRouter.createCaller>[0]);
beforeEach(() => vi.resetAllMocks());

it("reports the encrypted-environment refusal through the MariaDB subscription", async () => {
	const failure = new Error("Environment variables could not be decrypted");
	mocks.deployMariadb.mockRejectedValue(failure);
	const stream = await caller.deployWithLogs({ mariadbId: "db-1" });
	const error = vi.fn();
	stream.subscribe({ error });
	await vi.waitFor(() => expect(error).toHaveBeenCalledWith(failure));
	expect(error).toHaveBeenCalledOnce();
});

it("streams MariaDB deployment logs and completes on success", async () => {
	mocks.deployMariadb.mockImplementation(
		async (_id: string, log: (value: string) => void) => log("deployed"),
	);
	const stream = await caller.deployWithLogs({ mariadbId: "db-1" });
	const next = vi.fn();
	const complete = vi.fn();
	stream.subscribe({ next, complete });
	await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
	expect(next).toHaveBeenCalledWith("deployed");
});
