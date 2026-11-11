import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: vi.fn(async () => ({
		serverId: "server-1",
		name: "fixture",
		organizationId: "org-a",
		sshKeyId: "key-1",
		sshKey: null,
		username: "root",
		port: 22,
	})),
}));
vi.mock("@dokploy/server/services/web-server-settings", () => ({
	getWebServerSettings: vi.fn(async () => ({ serverIp: "192.0.2.1" })),
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsyncRemote: vi.fn(async () => ({ stdout: "", stderr: "" })),
}));
vi.mock("@dokploy/server", async () => {
	const services = await import("@dokploy/server/services/server-security");
	const { findServerById } = await import("@dokploy/server/services/server");
	return {
		...services,
		findServerById,
		getAccessibleServerIds: vi.fn(async () => new Set(["server-1"])),
		// Spies ensure the router refuses before entering even a guarded service.
		configureFail2ban: vi.fn(services.configureFail2ban),
		setFail2banEnabled: vi.fn(services.setFail2banEnabled),
		banFail2banIp: vi.fn(services.banFail2banIp),
		unbanFail2banIp: vi.fn(services.unbanFail2banIp),
		updateSshSettings: vi.fn(services.updateSshSettings),
		removeAuthorizedKey: vi.fn(services.removeAuthorizedKey),
		disconnectSshSession: vi.fn(services.disconnectSshSession),
		getPendingUpdates: vi.fn(services.getPendingUpdates),
	};
});
vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));
vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(),
}));
vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));

import * as routerServices from "@dokploy/server";
import * as services from "@dokploy/server/services/server-security";
import { BuildAdmissionError } from "@dokploy/server/utils/process/build-admission";
import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";
import { audit } from "@/server/api/utils/audit";

const { serverSecurityRouter } = await import(
	"@/server/api/routers/server-security"
);
const caller = serverSecurityRouter.createCaller({
	session: { userId: "admin", activeOrganizationId: "org-a" },
	user: { id: "admin", role: "admin" },
} as Parameters<typeof serverSecurityRouter.createCaller>[0]);

const serverId = "server-1";
const config = { bantime: 3600, findtime: 600, maxretry: 5, ignoreip: [] };
const settings = {
	passwordAuthentication: false,
	permitRootLogin: "prohibit-password" as const,
	maxAuthTries: 6,
};
const fingerprint = `SHA256:${"A".repeat(43)}`;
const cases = [
	{
		name: "configureFail2ban",
		router: () => caller.configureFail2ban({ serverId, ...config }),
		service: () => services.configureFail2ban(serverId, config),
		dispatch: routerServices.configureFail2ban,
	},
	{
		name: "setFail2banEnabled",
		router: () => caller.setFail2banEnabled({ serverId, enabled: true }),
		service: () => services.setFail2banEnabled(serverId, true),
		dispatch: routerServices.setFail2banEnabled,
	},
	{
		name: "banIp",
		router: () => caller.banIp({ serverId, ip: "198.51.100.2" }),
		service: () => services.banFail2banIp(serverId, "198.51.100.2"),
		dispatch: routerServices.banFail2banIp,
	},
	{
		name: "unbanIp",
		router: () =>
			caller.unbanIp({ serverId, jail: "sshd", ip: "198.51.100.2" }),
		service: () => services.unbanFail2banIp(serverId, "sshd", "198.51.100.2"),
		dispatch: routerServices.unbanFail2banIp,
	},
	{
		name: "updateSshSettings",
		router: () => caller.updateSshSettings({ serverId, ...settings }),
		service: () => services.updateSshSettings(serverId, settings),
		dispatch: routerServices.updateSshSettings,
	},
	{
		name: "removeAuthorizedKey",
		router: () => caller.removeAuthorizedKey({ serverId, fingerprint }),
		service: () => services.removeAuthorizedKey(serverId, fingerprint),
		dispatch: routerServices.removeAuthorizedKey,
	},
	{
		name: "disconnectSession",
		router: () => caller.disconnectSession({ serverId, terminal: "pts/1" }),
		service: () => services.disconnectSshSession(serverId, "pts/1"),
		dispatch: routerServices.disconnectSshSession,
	},
	{
		name: "pendingUpdates",
		router: () => caller.pendingUpdates({ serverId }),
		service: () => services.getPendingUpdates(serverId),
		dispatch: routerServices.getPendingUpdates,
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("DOKPLOY_BUILD_ADMISSION_MODE", "required");
});
afterEach(() => vi.unstubAllEnvs());

describe("server security admission", () => {
	it.each(cases)(
		"router refuses $name without remote execution",
		async (test) => {
			await expect(test.router()).rejects.toThrow(
				"host build admission is required",
			);
			expect(test.dispatch).not.toHaveBeenCalled();
			expect(execAsyncRemote).not.toHaveBeenCalled();
			expect(audit).not.toHaveBeenCalled();
		},
	);

	it.each(cases)(
		"service refuses $name without remote execution",
		async (test) => {
			await expect(test.service()).rejects.toBeInstanceOf(BuildAdmissionError);
			expect(execAsyncRemote).not.toHaveBeenCalled();
		},
	);

	it.each(["disabled", ""])(
		"retains remote mutation execution when mode is %s",
		async (mode) => {
			vi.stubEnv("DOKPLOY_BUILD_ADMISSION_MODE", mode);
			await expect(
				caller.setFail2banEnabled({ serverId, enabled: true }),
			).resolves.toBe(true);
			expect(execAsyncRemote).toHaveBeenCalledWith(
				serverId,
				expect.stringContaining("systemctl enable --now fail2ban"),
			);
			expect(audit).toHaveBeenCalledOnce();
		},
	);

	it.each([
		"fail2banStatus",
		"exposedPorts",
		"sshSecurity",
		"activity",
	] as const)(
		"allows the observational %s query in required mode",
		async (procedure) => {
			await expect(caller[procedure]({ serverId })).resolves.toBeDefined();
			expect(execAsyncRemote).toHaveBeenCalledOnce();
			expect(audit).not.toHaveBeenCalled();
		},
	);
});
