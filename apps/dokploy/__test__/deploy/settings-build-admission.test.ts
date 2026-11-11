import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	events: [] as string[],
	updateError: new Error("fixture update dispatch failed"),
}));

vi.mock("@dokploy/server/setup/traefik-setup", () => ({
	initializeStandaloneTraefik: vi.fn(),
	initializeTraefikService: vi.fn(),
}));

vi.mock("@dokploy/server/utils/docker/utils", () => ({
	pullImageUnderBuildAdmission: vi.fn(async () => {
		state.events.push("pull");
	}),
}));

vi.mock("@dokploy/server/utils/process/build-admission", () => ({
	withHostBuildAdmission: vi.fn(async (_options, callback) => {
		state.events.push("admission-start");
		await callback({
			prepareCommand: async (command: string) => command,
			signal: new AbortController().signal,
			assertLockHeld: () => undefined,
		});
		state.events.push("admission-release");
	}),
}));

vi.mock("@dokploy/server/utils/process/spawnAsync", () => ({
	spawnAsync: vi.fn(() => {
		state.events.push("service-update-dispatch");
		return Promise.reject(state.updateError);
	}),
}));

import {
	dispatchDokployUpdate,
	getUpdateData,
	togglePanelPort,
} from "@dokploy/server/services/settings";
import { spawnAsync } from "@dokploy/server/utils/process/spawnAsync";

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

import { execAsync } from "@dokploy/server/utils/process/execAsync";

describe("Dokploy self-update build admission", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("refuses stock updates on governed installs before admission, pull or service dispatch", async () => {
		vi.stubEnv("DOKPLOY_BUILD_ADMISSION_MODE", "required");
		await expect(dispatchDokployUpdate("latest")).rejects.toThrow(
			"fork's release process",
		);
		expect(state.events).toEqual([]);
		expect(execAsync).not.toHaveBeenCalled();
	});

	it.each([true, false])(
		"refuses panel port enable=%s before inspecting or updating Docker",
		async (enable) => {
			vi.stubEnv("DOKPLOY_BUILD_ADMISSION_MODE", "required");
			await expect(togglePanelPort(enable)).rejects.toThrow(
				"Panel port changes are unavailable",
			);
			expect(execAsync).not.toHaveBeenCalled();
			expect(state.events).toEqual([]);
		},
	);

	it("can report an available update without pulling or dispatching it", async () => {
		vi.stubEnv("DOKPLOY_BUILD_ADMISSION_MODE", "required");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{ name: "latest", digest: "sha256:new" },
						{ name: "v99.0.0", digest: "sha256:new" },
					],
					next: null,
				}),
			),
		);
		await expect(getUpdateData("v0.31.0")).resolves.toMatchObject({
			updateAvailable: true,
		});
		expect(state.events).toEqual([]);
		fetchSpy.mockRestore();
	});
	beforeEach(() => {
		state.events.length = 0;
		vi.clearAllMocks();
		vi.mocked(execAsync).mockResolvedValue({ stdout: "service", stderr: "" });
	});

	it("releases admission before dispatch and handles detached rejection", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(dispatchDokployUpdate("latest")).resolves.toBeUndefined();
		await Promise.resolve();

		expect(state.events).toEqual([
			"admission-start",
			"pull",
			"admission-release",
			"service-update-dispatch",
		]);
		expect(spawnAsync).toHaveBeenCalledWith("docker", [
			"service",
			"update",
			"--force",
			"--image",
			"dokploy/dokploy:latest",
			"dokploy",
		]);
		expect(errorSpy).toHaveBeenCalledWith(
			"Failed to dispatch Dokploy self-update",
			state.updateError,
		);

		errorSpy.mockRestore();
	});
});
