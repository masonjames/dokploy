import { beforeEach, expect, test, vi } from "vitest";

const serverMocks = vi.hoisted(() => ({
	applyCaddyMigration: vi.fn(),
	checkGPUStatus: vi.fn(),
	checkPortInUse: vi.fn(),
	checkPostgresHealth: vi.fn(),
	checkRedisHealth: vi.fn(),
	checkWebServerHealth: vi.fn(),
	cleanupAll: vi.fn(),
	cleanupAllBackground: vi.fn(),
	cleanupBuilders: vi.fn(),
	cleanupContainers: vi.fn(),
	cleanupImages: vi.fn(),
	cleanupSystem: vi.fn(),
	cleanupVolumes: vi.fn(),
	compileWriteAndReloadCaddyConfigSafely: vi.fn(),
	execAsync: vi.fn(),
	findServerById: vi.fn(),
	getCaddyCompileSettings: vi.fn(),
	getCaddyMigrationReport: vi.fn(),
	getCaddyTrustedProxySettings: vi.fn(),
	getDockerDiskUsage: vi.fn(),
	getDokployImageTag: vi.fn(),
	getLogCleanupStatus: vi.fn(),
	getUpdateData: vi.fn(),
	getWebServerPaths: vi.fn(),
	getWebServerResourceName: vi.fn(),
	getWebServerSettings: vi.fn(),
	parseRawConfig: vi.fn(),
	paths: vi.fn(),
	prepareCaddyMigration: vi.fn(),
	prepareEnvironmentVariables: vi.fn(),
	processLogs: vi.fn(),
	readCaddyConfigFileIfExists: vi.fn(),
	readConfig: vi.fn(),
	readConfigInPath: vi.fn(),
	readDirectory: vi.fn(),
	readEnvironmentVariables: vi.fn(),
	readMainConfig: vi.fn(),
	readMonitoringConfig: vi.fn(),
	readPorts: vi.fn(),
	recreateDirectory: vi.fn(),
	reloadCaddyAfterValidation: vi.fn(),
	reloadDockerResource: vi.fn(),
	resolveWebServerProvider: vi.fn(),
	rollbackCaddyMigration: vi.fn(),
	sendDockerCleanupNotifications: vi.fn(),
	setupGPUSupport: vi.fn(),
	spawnAsync: vi.fn(),
	startLogCleanup: vi.fn(),
	stopLogCleanup: vi.fn(),
	updateCaddyTrustedProxySettings: vi.fn(),
	updateLetsEncryptEmail: vi.fn(),
	updateLocalWebServerProvider: vi.fn(),
	updateRemoteWebServerProvider: vi.fn(),
	updateServerById: vi.fn(),
	updateServerCaddy: vi.fn(),
	updateServerTraefik: vi.fn(),
	updateWebServerSettings: vi.fn(),
	writeConfig: vi.fn(),
	writeMainConfig: vi.fn(),
	writeTraefikConfigInPath: vi.fn(),
	writeTraefikSetup: vi.fn(),
	writeWebServerSetup: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	...serverMocks,
	CLEANUP_CRON_JOB: "cleanup",
	DEFAULT_UPDATE_DATA: { latestVersion: null, updateAvailable: false },
	IS_CLOUD: false,
}));

vi.mock("@dokploy/trpc-openapi", () => ({
	generateOpenApiDocument: vi.fn(),
}));

vi.mock("@/server/api/root", () => ({
	appRouter: {},
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(),
}));

vi.mock("@/server/queues/queueSetup", () => ({
	cleanAllDeploymentQueue: vi.fn(),
}));

vi.mock("@/server/utils/backup", () => ({
	removeJob: vi.fn(),
	schedule: vi.fn(),
}));

import {
	compileWriteAndReloadCaddyConfigSafely,
	getCaddyCompileSettings,
	getCaddyTrustedProxySettings,
	readPorts,
	resolveWebServerProvider,
	updateCaddyTrustedProxySettings,
} from "@dokploy/server";
import { settingsRouter } from "@/server/api/routers/settings";
import { audit } from "@/server/api/utils/audit";

const caller = settingsRouter.createCaller({
	session: {
		userId: "user-1",
		activeOrganizationId: "org-1",
	},
	user: {
		id: "user-1",
		role: "owner",
		ownerId: "user-1",
		email: "owner@example.com",
		enableEnterpriseFeatures: true,
		isValidEnterpriseLicense: true,
	},
	req: { headers: {} },
	res: {},
} as never);

const staticInput = {
	mode: "static" as const,
	ranges: ["192.0.2.0/24"],
	clientIpHeaders: ["X-Forwarded-For"],
	strict: true,
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getCaddyCompileSettings).mockResolvedValue({
		letsEncryptEmail: "ops@example.com",
		trustedProxies: { source: "static", ranges: ["192.0.2.0/24"] },
	} as never);
	vi.mocked(getCaddyTrustedProxySettings)
		.mockResolvedValueOnce(null as never)
		.mockResolvedValueOnce(staticInput as never);
	vi.mocked(updateCaddyTrustedProxySettings).mockResolvedValue({} as never);
	vi.mocked(compileWriteAndReloadCaddyConfigSafely).mockResolvedValue(
		undefined as never,
	);
});

test("persists Caddy trusted proxy settings without rebuilding when Traefik is active", async () => {
	vi.mocked(resolveWebServerProvider).mockResolvedValue("traefik");

	const result = await caller.updateCaddyTrustedProxySettings(staticInput);

	expect(updateCaddyTrustedProxySettings).toHaveBeenCalledTimes(1);
	expect(updateCaddyTrustedProxySettings).toHaveBeenCalledWith(
		staticInput,
		undefined,
	);
	expect(compileWriteAndReloadCaddyConfigSafely).not.toHaveBeenCalled();
	expect(audit).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ resourceName: "caddy-trusted-proxy" }),
	);
	expect(result).toEqual(staticInput);
});

test("rebuilds Caddy with persisted compile settings when Caddy is active", async () => {
	vi.mocked(resolveWebServerProvider).mockResolvedValue("caddy");

	await caller.updateCaddyTrustedProxySettings(staticInput);

	expect(getCaddyCompileSettings).toHaveBeenCalledWith(undefined);
	expect(compileWriteAndReloadCaddyConfigSafely).toHaveBeenCalledWith({
		serverId: undefined,
		letsEncryptEmail: "ops@example.com",
		trustedProxies: { source: "static", ranges: ["192.0.2.0/24"] },
	});
	expect(audit).toHaveBeenCalled();
});

test("restores previous trusted proxy settings when active Caddy rebuild fails", async () => {
	vi.mocked(resolveWebServerProvider).mockResolvedValue("caddy");
	vi.mocked(getCaddyTrustedProxySettings).mockReset();
	vi.mocked(getCaddyTrustedProxySettings).mockResolvedValueOnce({
		mode: "cloudflare",
		clientIpHeaders: ["CF-Connecting-IP"],
		strict: true,
	} as never);
	vi.mocked(compileWriteAndReloadCaddyConfigSafely).mockRejectedValueOnce(
		new Error("caddy reload failed") as never,
	);

	await expect(
		caller.updateCaddyTrustedProxySettings(staticInput),
	).rejects.toThrow("caddy reload failed");

	expect(updateCaddyTrustedProxySettings).toHaveBeenNthCalledWith(
		1,
		staticInput,
		undefined,
	);
	expect(updateCaddyTrustedProxySettings).toHaveBeenNthCalledWith(
		2,
		{
			mode: "cloudflare",
			clientIpHeaders: ["CF-Connecting-IP"],
			strict: true,
		},
		undefined,
	);
	expect(audit).not.toHaveBeenCalled();
});

test("reports Caddy dashboard disabled instead of exposing the Caddy admin API", async () => {
	vi.mocked(resolveWebServerProvider).mockResolvedValue("caddy");

	const result = await caller.getWebServerDashboardState({});

	expect(result).toEqual({ provider: "caddy", enabled: false });
	expect(readPorts).not.toHaveBeenCalled();
});

test("keeps Traefik dashboard state based on the Traefik dashboard port", async () => {
	vi.mocked(resolveWebServerProvider).mockResolvedValue("traefik");
	vi.mocked(readPorts).mockResolvedValue([
		{ targetPort: 8080, publishedPort: 8080, protocol: "tcp" },
	] as never);

	const result = await caller.getWebServerDashboardState({});

	expect(readPorts).toHaveBeenCalledWith("dokploy-traefik", undefined);
	expect(result).toEqual({ provider: "traefik", enabled: true });
});
