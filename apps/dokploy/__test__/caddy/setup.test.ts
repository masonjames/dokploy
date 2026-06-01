import { afterEach, describe, expect, test, vi } from "vitest";

const validateCaddyConfigWithContainerMock = vi.hoisted(() => vi.fn());
const ensureDefaultCaddyConfigMock = vi.hoisted(() => vi.fn());
const getRemoteDockerMock = vi.hoisted(() => vi.fn());

vi.mock("@dokploy/server/utils/caddy/config", () => ({
	ensureDefaultCaddyConfig: ensureDefaultCaddyConfigMock,
	reloadCaddyAfterValidation: vi.fn(),
	validateCaddyConfigWithContainer: validateCaddyConfigWithContainerMock,
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: getRemoteDockerMock,
}));

const loadCaddySetup = async () => {
	vi.resetModules();
	vi.unstubAllEnvs();
	vi.stubEnv("CADDY_VERSION", "");
	return import("@dokploy/server/setup/caddy-setup");
};

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

describe("Caddy runtime setup", () => {
	test("defaults to the pinned Caddy 2.11.3 image tag", async () => {
		const { CADDY_VERSION } = await loadCaddySetup();

		expect(CADDY_VERSION).toBe("2.11.3");
	});

	test("uses the pinned default image for standalone Caddy", async () => {
		const createContainer = vi.fn();
		const start = vi.fn();
		const remove = vi.fn().mockRejectedValue(new Error("missing"));
		const docker = {
			pull: vi.fn(
				(_imageName: string, callback: (error: Error | null) => void) => {
					callback(null);
				},
			),
			modem: { followProgress: vi.fn() },
			createContainer,
			getContainer: vi.fn(() => ({ remove, start })),
		};
		getRemoteDockerMock.mockResolvedValue(docker);
		ensureDefaultCaddyConfigMock.mockResolvedValue(undefined);
		validateCaddyConfigWithContainerMock.mockResolvedValue(undefined);
		const { initializeStandaloneCaddy } = await loadCaddySetup();

		await initializeStandaloneCaddy();

		expect(docker.pull).toHaveBeenCalledWith(
			"caddy:2.11.3",
			expect.any(Function),
		);
		expect(createContainer).toHaveBeenCalledWith(
			expect.objectContaining({
				Image: "caddy:2.11.3",
				HostConfig: expect.objectContaining({
					Binds: expect.arrayContaining([
						expect.stringMatching(/\/caddy:\/etc\/caddy$/),
					]),
				}),
			}),
		);
		expect(
			(createContainer.mock.calls[0]?.[0] as any).HostConfig.Binds,
		).not.toEqual(
			expect.arrayContaining([
				expect.stringMatching(
					/\/caddy\/caddy\.json:\/etc\/caddy\/caddy\.json$/,
				),
			]),
		);
	});
});
