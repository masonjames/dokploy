import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	context: {
		assertLockHeld: vi.fn(),
		prepareCommand: vi.fn(),
		signal: new AbortController().signal,
	},
}));

const dockerMocks = vi.hoisted(() => ({
	createService: vi.fn(),
	getService: vi.fn(),
	inspect: vi.fn(),
	update: vi.fn(),
}));

vi.mock("@dokploy/server/lib/auth-secret", () => ({
	betterAuthSecret: "fixture-better-auth-secret",
}));

vi.mock("@dokploy/server/utils/docker/utils", () => ({
	pullImageUnderBuildAdmission: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@dokploy/server/utils/process/build-admission", () => ({
	withHostBuildAdmission: vi.fn(async (_options, callback) =>
		callback(state.context),
	),
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: vi.fn(async () => ({
		createService: dockerMocks.createService,
		getService: dockerMocks.getService,
	})),
}));

import { setupForwardAuth } from "@dokploy/server/setup/forward-auth-setup";
import { pullImageUnderBuildAdmission } from "@dokploy/server/utils/docker/utils";
import { withHostBuildAdmission } from "@dokploy/server/utils/process/build-admission";

const options = {
	authDomain: "auth.example.test",
	baseDomain: ".example.test",
	cookieSecret: "fixture-cookie-secret",
	oidc: {
		clientId: "fixture-client-id",
		clientSecret: "fixture-client-secret",
		issuer: "https://issuer.example.test",
	},
};

describe("forward-auth service admission", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.context.assertLockHeld = vi.fn();
		dockerMocks.getService.mockReturnValue({
			inspect: dockerMocks.inspect,
			update: dockerMocks.update,
		});
		dockerMocks.inspect.mockResolvedValue({
			Spec: { TaskTemplate: { ForceUpdate: 4 } },
			Version: { Index: "7" },
		});
		dockerMocks.update.mockResolvedValue(undefined);
		dockerMocks.createService.mockResolvedValue(undefined);
	});

	it("propagates an existing-service update failure without attempting create", async () => {
		const updateError = new Error("fixture forward-auth update rejected");
		dockerMocks.update.mockRejectedValueOnce(updateError);

		await expect(setupForwardAuth(options)).rejects.toBe(updateError);

		expect(withHostBuildAdmission).toHaveBeenCalledWith(
			{ operation: "forward-auth-setup", serverId: null },
			expect.any(Function),
		);
		expect(pullImageUnderBuildAdmission).toHaveBeenCalledWith(
			expect.objectContaining({ context: state.context, serverId: null }),
		);
		expect(dockerMocks.createService).not.toHaveBeenCalled();
	});

	it("creates only after inspect proves that the service is absent", async () => {
		dockerMocks.inspect.mockRejectedValueOnce(
			Object.assign(new Error("fixture missing service"), { statusCode: 404 }),
		);

		await expect(setupForwardAuth(options)).resolves.toBeUndefined();

		expect(dockerMocks.update).not.toHaveBeenCalled();
		expect(dockerMocks.createService).toHaveBeenCalledTimes(1);
		expect(state.context.assertLockHeld).toHaveBeenCalledTimes(2);
	});

	it("propagates non-not-found inspect failures", async () => {
		const inspectError = Object.assign(new Error("fixture daemon failure"), {
			statusCode: 500,
		});
		dockerMocks.inspect.mockRejectedValueOnce(inspectError);

		await expect(setupForwardAuth(options)).rejects.toBe(inspectError);
		expect(dockerMocks.update).not.toHaveBeenCalled();
		expect(dockerMocks.createService).not.toHaveBeenCalled();
	});
});
