import { expect, test, vi } from "vitest";
import { invalidateApplicationWebServerConfig } from "@/components/dashboard/application/web-server-config-cache";

const createUtils = () => ({
	application: {
		readTraefikConfig: {
			invalidate: vi.fn(),
		},
		readWebServerConfig: {
			invalidate: vi.fn(),
		},
	},
});

test("invalidates legacy Traefik and provider-aware application web-server config caches", async () => {
	const utils = createUtils();

	await invalidateApplicationWebServerConfig(utils, "app-1");

	expect(utils.application.readTraefikConfig.invalidate).toHaveBeenCalledWith({
		applicationId: "app-1",
	});
	expect(utils.application.readWebServerConfig.invalidate).toHaveBeenCalledWith(
		{ applicationId: "app-1" },
	);
});

test("awaits both application web-server config cache invalidations", async () => {
	const calls: string[] = [];
	const utils = createUtils();
	utils.application.readTraefikConfig.invalidate.mockImplementation(
		async () => {
			await Promise.resolve();
			calls.push("traefik");
		},
	);
	utils.application.readWebServerConfig.invalidate.mockImplementation(
		async () => {
			await Promise.resolve();
			calls.push("web-server");
		},
	);

	await invalidateApplicationWebServerConfig(utils, "app-1");

	expect(calls).toEqual(["traefik", "web-server"]);
});

test("propagates application web-server config cache invalidation failures", async () => {
	const utils = createUtils();
	utils.application.readWebServerConfig.invalidate.mockRejectedValueOnce(
		new Error("provider-aware cache failed"),
	);

	await expect(
		invalidateApplicationWebServerConfig(utils, "app-1"),
	).rejects.toThrow("provider-aware cache failed");
	expect(utils.application.readTraefikConfig.invalidate).toHaveBeenCalledWith({
		applicationId: "app-1",
	});
});
