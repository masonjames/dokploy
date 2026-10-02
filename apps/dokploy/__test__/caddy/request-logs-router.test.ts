import { beforeEach, expect, test, vi } from "vitest";

const getWebServerProvider = vi.hoisted(() => vi.fn());
const setCaddyRequestLogs = vi.hoisted(() => vi.fn());

vi.mock("@dokploy/server", async (original) => ({
	...(await original<typeof import("@dokploy/server")>()),
	IS_CLOUD: false,
	getWebServerProvider,
	setCaddyRequestLogs,
}));
vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));

import { settingsRouter } from "@/server/api/routers/settings";

const as = (role: string) =>
	settingsRouter.createCaller({
		session: { userId: "user-1", activeOrganizationId: "org-1" },
		user: { id: "user-1", role, ownerId: "user-1", email: "user@example.com" },
		req: { headers: {} },
		res: {},
	} as never);

beforeEach(() => {
	vi.clearAllMocks();
	getWebServerProvider.mockResolvedValue("caddy");
});

test("on Caddy a member cannot turn the request log on or off", async () => {
	await expect(
		as("member").toggleRequests({ enable: false }),
	).rejects.toMatchObject({ code: "UNAUTHORIZED" });

	expect(setCaddyRequestLogs).not.toHaveBeenCalled();
});

test("on Caddy an admin's change reloads Caddy through the toggle", async () => {
	expect(await as("admin").toggleRequests({ enable: false })).toBe(true);

	expect(setCaddyRequestLogs).toHaveBeenCalledWith(false);
});
