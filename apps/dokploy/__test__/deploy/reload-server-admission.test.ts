import type { BuildAdmissionContext } from "@dokploy/server/utils/process/build-admission";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	events: [] as string[],
	reloadDockerResource: vi.fn(),
}));

vi.mock("@dokploy/server", async () => {
	const { assertDokployUpdateSupported } = await import(
		"@dokploy/server/services/settings"
	);
	return {
		IS_CLOUD: false,
		assertDokployUpdateSupported,
		reloadDockerResource: mocks.reloadDockerResource,
	};
});
vi.mock("@dokploy/server/setup/traefik-setup", () => ({}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(async (command: string) => {
		mocks.events.push(command.includes("inspect") ? "inspect" : "update");
		return { stdout: "service", stderr: "" };
	}),
	execAsyncRemote: vi.fn(async (_serverId: string, command: string) => {
		mocks.events.push(command.includes("inspect") ? "inspect" : "update");
		return { stdout: "service", stderr: "" };
	}),
}));
vi.mock("@dokploy/server/utils/docker/utils", () => ({
	pullImageUnderBuildAdmission: vi.fn(async () => {
		mocks.events.push("pull");
	}),
}));
vi.mock("@dokploy/server/utils/process/build-admission", () => ({
	withHostBuildAdmission: vi.fn(
		async (
			_options: unknown,
			callback: (context: BuildAdmissionContext) => Promise<unknown>,
		) => {
			mocks.events.push("admission");
			return callback({
				prepareCommand: async (command) => command,
				signal: new AbortController().signal,
				assertLockHeld: () => undefined,
			});
		},
	),
}));
vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));
vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));
vi.mock("@/server/queues/queueSetup", () => ({
	cleanAllDeploymentQueue: vi.fn(),
}));
vi.mock("@/server/utils/backup", () => ({
	removeJob: vi.fn(),
	schedule: vi.fn(),
}));

import { reloadDockerResource } from "@dokploy/server/services/settings";
import { pullImageUnderBuildAdmission } from "@dokploy/server/utils/docker/utils";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { audit } from "@/server/api/utils/audit";

const { settingsRouter } = await import("@/server/api/routers/settings");
const caller = settingsRouter.createCaller({
	session: { activeOrganizationId: "org-a" },
	user: { id: "admin", role: "admin" },
} as Parameters<typeof settingsRouter.createCaller>[0]);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.events.length = 0;
	vi.stubEnv("DOKPLOY_BUILD_ADMISSION_MODE", "disabled");
	vi.stubEnv("RELEASE_TAG", "latest");
	mocks.reloadDockerResource.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("governed Dokploy reload", () => {
	it("router refuses before shared reload dispatch or audit", async () => {
		vi.stubEnv("DOKPLOY_BUILD_ADMISSION_MODE", "required");
		await expect(caller.reloadServer()).rejects.toThrow(
			"fork's release process",
		);
		expect(mocks.reloadDockerResource).not.toHaveBeenCalled();
		expect(audit).not.toHaveBeenCalled();
		expect(mocks.events).toEqual([]);
	});

	it("router retains reload and audit outside required mode", async () => {
		await expect(caller.reloadServer()).resolves.toBe(true);
		expect(mocks.reloadDockerResource).toHaveBeenCalledWith(
			"dokploy",
			undefined,
			"v0.31.0",
		);
		expect(audit).toHaveBeenCalledOnce();
	});

	it.each([undefined, "server-1"])(
		"shared reload refuses before inspect, pull or update on %s",
		async (serverId) => {
			vi.stubEnv("DOKPLOY_BUILD_ADMISSION_MODE", "required");
			await expect(
				reloadDockerResource("dokploy", serverId, "v0.31.0"),
			).rejects.toThrow("fork's release process");
			expect(execAsync).not.toHaveBeenCalled();
			expect(execAsyncRemote).not.toHaveBeenCalled();
			expect(pullImageUnderBuildAdmission).not.toHaveBeenCalled();
			expect(mocks.events).toEqual([]);
		},
	);

	it.each([undefined, "server-1"])(
		"shared reload retains admitted pull and update outside required mode on %s",
		async (serverId) => {
			await reloadDockerResource("dokploy", serverId, "v0.31.0");
			expect(mocks.events).toEqual(["inspect", "admission", "pull", "update"]);
			expect(pullImageUnderBuildAdmission).toHaveBeenCalledWith({
				context: expect.objectContaining({ signal: expect.any(AbortSignal) }),
				dockerImage: "dokploy/dokploy:v0.31.0",
				serverId: serverId ?? null,
			});
			const executor = serverId ? execAsyncRemote : execAsync;
			expect(executor).toHaveBeenLastCalledWith(
				...(serverId ? [serverId] : []),
				"docker service update --force --image dokploy/dokploy:v0.31.0 dokploy",
			);
		},
	);

	it("does not block reloads of other resources", async () => {
		vi.stubEnv("DOKPLOY_BUILD_ADMISSION_MODE", "required");
		await reloadDockerResource("another-service");
		expect(mocks.events).toEqual(["inspect", "admission", "update"]);
	});
});
