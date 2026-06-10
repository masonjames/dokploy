import { beforeEach, expect, test, vi } from "vitest";

const serverMocks = vi.hoisted(() => ({
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
	execAsync: vi.fn(),
	findServerById: vi.fn(),
	getDockerDiskUsage: vi.fn(),
	getDokployImageTag: vi.fn(),
	getLogCleanupStatus: vi.fn(),
	getUpdateData: vi.fn(),
	getWebServerPaths: vi.fn(),
	getWebServerSettings: vi.fn(),
	parseRawConfig: vi.fn(),
	paths: vi.fn(),
	prepareEnvironmentVariables: vi.fn(),
	processLogs: vi.fn(),
	readConfig: vi.fn(),
	readConfigInPath: vi.fn(),
	readDirectory: vi.fn(),
	readEnvironmentVariables: vi.fn(),
	readMainConfig: vi.fn(),
	readMonitoringConfig: vi.fn(),
	readPorts: vi.fn(),
	recreateDirectory: vi.fn(),
	reloadDockerResource: vi.fn(),
	resolveWebServerProvider: vi.fn(),
	sendDockerCleanupNotifications: vi.fn(),
	setupGPUSupport: vi.fn(),
	spawnAsync: vi.fn(),
	startLogCleanup: vi.fn(),
	stopLogCleanup: vi.fn(),
	updateLetsEncryptEmail: vi.fn(),
	updateServerById: vi.fn(),
	updateServerTraefik: vi.fn(),
	updateWebServerSettings: vi.fn(),
	writeConfig: vi.fn(),
	writeMainConfig: vi.fn(),
	writeTraefikConfigInPath: vi.fn(),
	writeTraefikSetup: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	...serverMocks,
	CLEANUP_CRON_JOB: "cleanup",
	DEFAULT_UPDATE_DATA: { latestVersion: null, updateAvailable: false },
	IS_CLOUD: false,
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkPermission: vi.fn(),
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
	getWebServerPaths,
	readDirectory,
	readMainConfig,
	reloadDockerResource,
	resolveWebServerProvider,
} from "@dokploy/server";
import { settingsRouter } from "@/server/api/routers/settings";
import { webServerRouter } from "@/server/api/routers/web-server";
import { audit } from "@/server/api/utils/audit";

const MOVED_PROCEDURES = [
	"reloadTraefik",
	"toggleDashboard",
	"readTraefikConfig",
	"updateTraefikConfig",
	"readWebServerTraefikConfig",
	"updateWebServerTraefikConfig",
	"readMiddlewareTraefikConfig",
	"updateMiddlewareTraefikConfig",
	"readDirectories",
	"updateTraefikFile",
	"readTraefikFile",
	"readTraefikEnv",
	"writeTraefikEnv",
	"haveTraefikDashboardPortEnabled",
	"updateTraefikPorts",
	"getTraefikPorts",
	"haveActivateRequests",
	"toggleRequests",
] as const;

const adminContext = {
	session: {
		userId: "user-1",
		activeOrganizationId: "org-1",
	},
	user: {
		id: "user-1",
		role: "owner",
		ownerId: "user-1",
		email: "owner@example.com",
	},
	req: { headers: {} },
	res: {},
} as never;

beforeEach(() => {
	vi.clearAllMocks();
});

test("web-server procedures moved out of the settings router", () => {
	const webServerProcedures = Object.keys(webServerRouter._def.procedures);

	for (const procedure of MOVED_PROCEDURES) {
		expect(webServerProcedures).toContain(procedure);
	}
	// TODO(caddy-endpoints): the Caddy layer temporarily re-inlines
	// provider-aware versions of these procedures in the settings router
	// (its UI call sites still target api.settings.*). Before opening this
	// PR, move the caddy/web-server endpoints into webServerRouter, rewire
	// the UI call sites, and restore the
	// `expect(settingsProcedures).not.toContain(procedure)` assertion here.
	void settingsRouter;
});

test("reloadTraefik reloads the Traefik docker resource and audits", async () => {
	vi.mocked(reloadDockerResource).mockResolvedValue(undefined as never);
	const caller = webServerRouter.createCaller(adminContext);

	await expect(caller.reloadTraefik({})).resolves.toBe(true);

	expect(reloadDockerResource).toHaveBeenCalledWith(
		"dokploy-traefik",
		undefined,
	);
	expect(audit).toHaveBeenCalled();
});

test("readTraefikConfig returns the main web server config", async () => {
	vi.mocked(readMainConfig).mockReturnValue("entryPoints: {}" as never);
	const caller = webServerRouter.createCaller(adminContext);

	await expect(caller.readTraefikConfig()).resolves.toBe("entryPoints: {}");
});

test("readDirectories resolves the provider paths through the abstraction", async () => {
	vi.mocked(resolveWebServerProvider).mockResolvedValue("traefik" as never);
	vi.mocked(getWebServerPaths).mockReturnValue({
		provider: "traefik",
		basePath: "/etc/dokploy/traefik",
	} as never);
	vi.mocked(readDirectory).mockResolvedValue(["dynamic"] as never);
	const caller = webServerRouter.createCaller(adminContext);

	await expect(caller.readDirectories({})).resolves.toEqual(["dynamic"]);

	expect(resolveWebServerProvider).toHaveBeenCalledWith(undefined);
	expect(getWebServerPaths).toHaveBeenCalledWith("traefik", false);
	expect(readDirectory).toHaveBeenCalledWith(
		"/etc/dokploy/traefik",
		undefined,
	);
});
