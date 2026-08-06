import * as buildAdmission from "@dokploy/server/utils/process/build-admission";
import * as execProcess from "@dokploy/server/utils/process/execAsync";
import { beforeEach, describe, expect, it, vi } from "vitest";

const signal = new AbortController().signal;
const assertLockHeld = vi.fn();
const prepareCommand = vi.fn(async (command: string) => `ADMITTED:${command}`);

vi.mock("@dokploy/server/constants", () => ({
	docker: {},
	paths: {},
}));

vi.mock("@dokploy/server/utils/process/build-admission", () => ({
	withHostBuildAdmission: vi.fn(async (_options, callback) =>
		callback({ assertLockHeld, prepareCommand, signal }),
	),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	execAsyncRemote: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	execAsyncStream: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/spawnAsync", () => ({
	spawnAsync: vi.fn(),
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: vi.fn(),
}));

import {
	startService,
	startServiceRemote,
} from "@dokploy/server/utils/docker/utils";

describe("service start build admission", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("admits a quoted local scale-to-one command under the holder signal", async () => {
		await startService("local service;unexpected-command");

		expect(buildAdmission.withHostBuildAdmission).toHaveBeenCalledWith(
			{ serverId: null, operation: "service-start" },
			expect.any(Function),
		);
		expect(prepareCommand).toHaveBeenCalledWith(
			"docker service scale 'local service;unexpected-command=1'",
		);
		expect(execProcess.execAsync).toHaveBeenCalledWith(
			"ADMITTED:docker service scale 'local service;unexpected-command=1'",
			{ signal },
		);
		expect(assertLockHeld).toHaveBeenCalledTimes(2);
	});

	it("admits a quoted remote scale-to-one command under the holder signal", async () => {
		await startServiceRemote("remote-server", "remote service;unexpected");

		expect(buildAdmission.withHostBuildAdmission).toHaveBeenCalledWith(
			{ serverId: "remote-server", operation: "service-start" },
			expect.any(Function),
		);
		expect(prepareCommand).toHaveBeenCalledWith(
			"docker service scale 'remote service;unexpected=1'",
		);
		expect(execProcess.execAsyncRemote).toHaveBeenCalledWith(
			"remote-server",
			"ADMITTED:docker service scale 'remote service;unexpected=1'",
			undefined,
			signal,
		);
		expect(assertLockHeld).toHaveBeenCalledTimes(2);
	});
});
