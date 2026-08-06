import type { BuildAdmissionContext } from "@dokploy/server/utils/process/build-admission";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/constants", () => ({
	docker: {},
	paths: {},
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	execAsyncStream: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
}));

vi.mock("@dokploy/server/utils/process/spawnAsync", () => ({
	spawnAsync: vi.fn(),
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: vi.fn(),
}));

import { pullImageUnderBuildAdmission } from "@dokploy/server/utils/docker/utils";
import {
	execAsyncRemote,
	execAsyncStream,
} from "@dokploy/server/utils/process/execAsync";

describe("admitted image pull", () => {
	const signal = new AbortController().signal;
	const context: BuildAdmissionContext = {
		prepareCommand: vi.fn(async (command) => `OWNED:${command}`),
		signal,
		assertLockHeld: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("wraps and awaits local and remote pulls under the holder signal", async () => {
		await pullImageUnderBuildAdmission({
			context,
			dockerImage: "registry.example.test/example/app:v1",
			serverId: null,
		});

		expect(context.prepareCommand).toHaveBeenCalledWith(
			expect.stringMatching(
				/^docker pull registry\.example\.test\/example\/app\\:v1$/,
			),
		);
		expect(execAsyncStream).toHaveBeenCalledWith(
			expect.stringMatching(/^OWNED:docker pull /),
			undefined,
			{ signal },
		);

		await pullImageUnderBuildAdmission({
			context,
			dockerImage: "postgres:16",
			serverId: "database-server",
		});

		expect(execAsyncRemote).toHaveBeenCalledWith(
			"database-server",
			expect.stringMatching(/^OWNED:docker pull /),
			undefined,
			signal,
		);
		expect(context.assertLockHeld).toHaveBeenCalledTimes(4);
	});
});
