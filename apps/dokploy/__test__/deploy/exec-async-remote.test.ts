import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	clients: [] as Array<{ end: ReturnType<typeof vi.fn> }>,
}));

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: vi.fn().mockResolvedValue({
		ipAddress: "192.0.2.10",
		port: 22,
		username: "fixture",
		sshKeyId: "ssh-key-id",
		sshKey: { privateKey: "fixture-private-key" },
	}),
}));

vi.mock("ssh2", () => ({
	Client: class Client {
		private ready?: () => void;
		end = vi.fn();

		constructor() {
			state.clients.push(this);
		}

		on(event: string, callback: () => void) {
			if (event === "error") void callback;
			return this;
		}

		once(event: string, callback: () => void) {
			if (event === "ready") this.ready = callback;
			return this;
		}

		connect() {
			queueMicrotask(() => this.ready?.());
			return this;
		}

		exec(_command: string, callback: (error: Error, stream?: unknown) => void) {
			callback(new Error("fixture exec failure"));
		}
	},
}));

import { execAsyncRemote } from "@dokploy/server/utils/process/execAsync";

describe("execAsyncRemote cleanup", () => {
	it("removes the abort listener and closes SSH when exec setup fails", async () => {
		const controller = new AbortController();
		const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

		await expect(
			execAsyncRemote("server-id", "true", undefined, controller.signal),
		).rejects.toThrow("Remote command execution failed: fixture exec failure");

		expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
		expect(state.clients).toHaveLength(1);
		expect(state.clients[0]?.end).toHaveBeenCalledOnce();
	});
});
