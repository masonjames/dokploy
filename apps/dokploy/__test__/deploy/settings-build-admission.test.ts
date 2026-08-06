import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { dispatchDokployUpdate } from "@dokploy/server/services/settings";
import { spawnAsync } from "@dokploy/server/utils/process/spawnAsync";

describe("Dokploy self-update build admission", () => {
	beforeEach(() => {
		state.events.length = 0;
		vi.clearAllMocks();
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
