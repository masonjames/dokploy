import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getWebServerProvider: vi.fn(),
	restoreInterruptedTraefik: vi.fn(),
	initCronJobs: vi.fn(),
	initSchedules: vi.fn(),
	initCancelDeployments: vi.fn(),
	initVolumeBackupsCronJobs: vi.fn(),
	initEnterpriseBackupCronJobs: vi.fn(),
	startDeploymentWorker: vi.fn(),
}));
vi.mock("@dokploy/server", () => ({
	...mocks,
	IS_CLOUD: false,
	setupDirectories: vi.fn(),
	createDefaultTraefikConfig: vi.fn(),
	createDefaultServerTraefikConfig: vi.fn(),
	createDefaultMiddlewares: vi.fn(),
	syncAllCaddyInBackground: vi.fn(),
	initializeNetwork: vi.fn(),
	sendDokployRestartNotifications: vi.fn(),
}));
vi.mock("node:http", () => ({
	default: { createServer: () => ({ listen: vi.fn() }) },
}));
vi.mock("next", () => ({
	default: () => ({ prepare: async () => {}, getRequestHandler: vi.fn() }),
}));
vi.mock("@/server/wss/docker-container-logs", () => ({
	setupDockerContainerLogsWebSocketServer: vi.fn(),
}));
vi.mock("@/server/wss/docker-container-terminal", () => ({
	setupDockerContainerTerminalWebSocketServer: vi.fn(),
}));
vi.mock("@/server/wss/docker-stats", () => ({
	setupDockerStatsMonitoringSocketServer: vi.fn(),
}));
vi.mock("@/server/wss/drawer-logs", () => ({
	setupDrawerLogsWebSocketServer: vi.fn(),
}));
vi.mock("@/server/wss/listen-deployment", () => ({
	setupDeploymentLogsWebSocketServer: vi.fn(),
}));
vi.mock("@/server/wss/terminal", () => ({
	setupTerminalWebSocketServer: vi.fn(),
}));
vi.mock("@/server/queues/queueSetup", () => ({
	startDeploymentWorker: mocks.startDeploymentWorker,
}));
vi.mock("dotenv", () => ({ config: vi.fn() }));

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});
it.each(["unknown", "caddy", "traefik"])(
	"continues cron and worker startup with provider %s",
	async (provider) => {
		vi.resetModules();
		vi.clearAllMocks();
		mocks.restoreInterruptedTraefik.mockResolvedValue(undefined);
		vi.stubEnv("NODE_ENV", "production");
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		if (provider === "unknown")
			mocks.getWebServerProvider.mockRejectedValue(
				new Error("database unavailable"),
			);
		else mocks.getWebServerProvider.mockResolvedValue(provider);
		await import("@/server/server");
		await vi.waitFor(() =>
			expect(mocks.startDeploymentWorker).toHaveBeenCalledOnce(),
		);
		expect(mocks.restoreInterruptedTraefik).toHaveBeenCalledTimes(
			provider === "traefik" ? 1 : 0,
		);
		for (const init of [
			mocks.initCronJobs,
			mocks.initSchedules,
			mocks.initCancelDeployments,
			mocks.initVolumeBackupsCronJobs,
			mocks.initEnterpriseBackupCronJobs,
		])
			expect(init).toHaveBeenCalledOnce();
	},
);
