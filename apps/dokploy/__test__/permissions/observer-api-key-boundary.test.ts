import { beforeEach, expect, test, vi } from "vitest";

const mockCreateApiKey = vi.hoisted(() => vi.fn());

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	createApiKey: mockCreateApiKey,
	createOrganizationUserWithCredentials: vi.fn(),
	findNotificationById: vi.fn(),
	findOrganizationById: vi.fn(),
	findPasskeysByUserId: vi.fn(),
	findUserById: vi.fn(),
	getDokployUrl: vi.fn(),
	getUserByToken: vi.fn(),
	getWebServerSettings: vi.fn(),
	removeUserById: vi.fn(),
	renderInvitationEmail: vi.fn(),
	sendEmailNotification: vi.fn(),
	sendResendNotification: vi.fn(),
	updateUser: vi.fn(),
}));

vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));

import { db } from "@dokploy/server/db";
import { directApiKeyPaths } from "@dokploy/server/lib/access-control";
import { userRouter } from "@/server/api/routers/user";

const caller = userRouter.createCaller({
	session: {
		userId: "owner-1",
		activeOrganizationId: "org-1",
	},
	user: {
		id: "owner-1",
		role: "owner",
		ownerId: "owner-1",
		email: "owner@example.com",
		enableEnterpriseFeatures: false,
		isValidEnterpriseLicense: false,
	},
	req: { headers: {} },
	res: {},
} as never);

const observerCaller = userRouter.createCaller({
	session: { userId: "observer-1", activeOrganizationId: "org-1" },
	user: {
		id: "observer-1",
		role: "observer",
		ownerId: "owner-1",
		email: "observer@example.com",
		enableEnterpriseFeatures: false,
		isValidEnterpriseLicense: false,
	},
	req: { headers: {} },
	res: {},
} as never);

beforeEach(() => {
	vi.clearAllMocks();
});

test("disables every direct Better Auth API-key route", () => {
	expect(directApiKeyPaths).toEqual([
		"/api-key/create",
		"/api-key/delete",
		"/api-key/get",
		"/api-key/list",
		"/api-key/update",
	]);
});

test("an administrator can create a key only for an observer in the active organization", async () => {
	vi.mocked(db.query.member.findFirst).mockResolvedValue({
		userId: "observer-1",
		organizationId: "org-1",
		role: "observer",
	} as never);
	mockCreateApiKey.mockResolvedValue({
		id: "key-1",
		key: "secret-value",
	} as never);

	await expect(
		caller.createObserverApiKey({
			userId: "observer-1",
			name: "codex-observer",
		}),
	).resolves.toMatchObject({ id: "key-1" });

	expect(mockCreateApiKey).toHaveBeenCalledWith("observer-1", {
		name: "codex-observer",
		metadata: { organizationId: "org-1" },
	});
});

test("the observer-key endpoint rejects non-observer targets", async () => {
	vi.mocked(db.query.member.findFirst).mockResolvedValue({
		userId: "member-1",
		organizationId: "org-1",
		role: "member",
	} as never);

	await expect(
		caller.createObserverApiKey({
			userId: "member-1",
			name: "codex-observer",
		}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(mockCreateApiKey).not.toHaveBeenCalled();
});

test("an observer cannot mint its own key", async () => {
	await expect(
		observerCaller.createObserverApiKey({
			userId: "observer-1",
			name: "codex-observer",
		}),
	).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	expect(mockCreateApiKey).not.toHaveBeenCalled();
});
