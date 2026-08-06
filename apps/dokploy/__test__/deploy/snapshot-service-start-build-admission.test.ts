import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	context: undefined as
		| {
				assertLockHeld: ReturnType<typeof vi.fn>;
				prepareCommand: ReturnType<typeof vi.fn>;
				signal: AbortSignal;
		  }
		| undefined,
	events: [] as string[],
	lockHeld: true,
	loseAfterPrepare: false,
	signal: new AbortController().signal,
}));

vi.mock("@dokploy/server/setup/caddy-setup", () => ({
	initializeCaddyService: vi.fn(),
	initializeStandaloneCaddy: vi.fn(),
}));

vi.mock("@dokploy/server/setup/traefik-setup", () => ({
	initializeStandaloneTraefik: vi.fn(),
	initializeTraefikService: vi.fn(),
}));

vi.mock("@dokploy/server/utils/docker/utils", () => ({
	pullImageUnderBuildAdmission: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/build-admission", () => ({
	withHostBuildAdmission: vi.fn(
		async (
			_options: unknown,
			callback: (
				context: NonNullable<typeof state.context>,
			) => Promise<unknown>,
		) => {
			state.events.push("admission-start");
			const context = {
				assertLockHeld: vi.fn(() => {
					if (!state.lockHeld) {
						throw new Error("fixture host build lock lost");
					}
				}),
				prepareCommand: vi.fn(async (command: string) => {
					state.events.push("prepare-scale");
					if (state.loseAfterPrepare) {
						state.lockHeld = false;
					}
					return `ADMITTED:${command}`;
				}),
				signal: state.signal,
			};
			state.context = context;
			try {
				return await callback(context);
			} finally {
				state.events.push("admission-release");
			}
		},
	),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(async () => {
		state.events.push("local-scale");
		return { stderr: "", stdout: "" };
	}),
	execAsyncRemote: vi.fn(async () => {
		state.events.push("remote-scale");
		return { stderr: "", stdout: "" };
	}),
}));

vi.mock("@dokploy/server/utils/process/spawnAsync", () => ({
	spawnAsync: vi.fn(),
}));

import { startDockerResourceFromSnapshot } from "@dokploy/server/services/settings";
import { withHostBuildAdmission } from "@dokploy/server/utils/process/build-admission";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";

describe("snapshot service scale-up build admission", () => {
	beforeEach(() => {
		state.context = undefined;
		state.events.length = 0;
		state.lockHeld = true;
		state.loseAfterPrepare = false;
		vi.clearAllMocks();
	});

	it.each([
		{ executionEvent: "local-scale", serverId: undefined },
		{ executionEvent: "remote-scale", serverId: "remote-server" },
	])(
		"admits a quoted $executionEvent command under the holder signal",
		async ({ executionEvent, serverId }) => {
			await startDockerResourceFromSnapshot(
				{
					replicas: 3,
					resourceName: "snapshot service;unexpected-command",
					resourceType: "service",
					running: true,
				},
				serverId,
			);

			expect(withHostBuildAdmission).toHaveBeenCalledWith(
				{
					operation: "snapshot-service-scale-up",
					serverId: serverId ?? null,
				},
				expect.any(Function),
			);
			expect(state.context?.prepareCommand).toHaveBeenCalledWith(
				"docker service scale 'snapshot service;unexpected-command=3'",
			);
			if (serverId) {
				expect(execAsync).not.toHaveBeenCalled();
				expect(execAsyncRemote).toHaveBeenCalledWith(
					serverId,
					"ADMITTED:docker service scale 'snapshot service;unexpected-command=3'",
					undefined,
					state.signal,
				);
			} else {
				expect(execAsyncRemote).not.toHaveBeenCalled();
				expect(execAsync).toHaveBeenCalledWith(
					"ADMITTED:docker service scale 'snapshot service;unexpected-command=3'",
					{ signal: state.signal },
				);
			}
			expect(state.context?.assertLockHeld).toHaveBeenCalledTimes(3);
			expect(state.events).toEqual([
				"admission-start",
				"prepare-scale",
				executionEvent,
				"admission-release",
			]);
		},
	);

	it("does not dispatch the scale after ownership is lost", async () => {
		state.loseAfterPrepare = true;

		await expect(
			startDockerResourceFromSnapshot({
				replicas: 2,
				resourceName: "dokploy-traefik",
				resourceType: "service",
				running: true,
			}),
		).rejects.toThrow("fixture host build lock lost");

		expect(execAsync).not.toHaveBeenCalled();
		expect(execAsyncRemote).not.toHaveBeenCalled();
		expect(state.events).toEqual([
			"admission-start",
			"prepare-scale",
			"admission-release",
		]);
	});

	it("keeps zero-scale and standalone starts on their existing paths", async () => {
		await startDockerResourceFromSnapshot({
			replicas: 0,
			resourceName: "zero-service",
			resourceType: "service",
			running: true,
		});
		await startDockerResourceFromSnapshot({
			resourceName: "standalone-resource",
			resourceType: "standalone",
			running: true,
		});

		expect(withHostBuildAdmission).not.toHaveBeenCalled();
		expect(execAsync).toHaveBeenNthCalledWith(
			1,
			"docker service scale zero-service=0",
		);
		expect(execAsync).toHaveBeenNthCalledWith(
			2,
			"docker start standalone-resource",
		);
		expect(execAsyncRemote).not.toHaveBeenCalled();
	});
});
