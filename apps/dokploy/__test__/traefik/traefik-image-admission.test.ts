import {
	ensureTraefikImage,
	TRAEFIK_VERSION,
} from "@dokploy/server/setup/traefik-setup";
import type { BuildAdmissionContext } from "@dokploy/server/utils/process/build-admission";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	inspect: vi.fn(),
	pull: vi.fn(),
	admittedPull: vi.fn(),
}));
vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: vi.fn(async () => ({
		getImage: () => ({ inspect: mocks.inspect }),
		pull: mocks.pull,
		modem: {
			followProgress: (
				_stream: unknown,
				callback: (error: Error | null) => void,
			) => callback(null),
		},
	})),
}));
vi.mock("@dokploy/server/utils/docker/utils", () => ({
	pullImageUnderBuildAdmission: mocks.admittedPull,
}));

beforeEach(() => {
	vi.resetAllMocks();
	mocks.inspect
		.mockRejectedValueOnce(new Error("missing"))
		.mockResolvedValue({});
});

it.each([undefined, "server-1"])(
	"pulls missing Traefik under the supplied admission context on %s",
	async (serverId) => {
		const context: BuildAdmissionContext = {
			assertLockHeld: vi.fn(),
			signal: new AbortController().signal,
			prepareCommand: async (command) => command,
		};
		await ensureTraefikImage(serverId, context);
		expect(mocks.admittedPull).toHaveBeenCalledWith({
			context,
			dockerImage: `traefik:v${TRAEFIK_VERSION}`,
			serverId: serverId ?? null,
		});
		expect(mocks.pull).not.toHaveBeenCalled();
		expect(mocks.inspect).toHaveBeenCalledTimes(2);
		expect(context.assertLockHeld).toHaveBeenCalledTimes(2);
	},
);

it("propagates admitted pull failure without a raw Docker pull", async () => {
	const context: BuildAdmissionContext = {
		assertLockHeld: vi.fn(),
		signal: new AbortController().signal,
		prepareCommand: async (command) => command,
	};
	mocks.admittedPull.mockRejectedValue(new Error("lock lost"));
	await expect(ensureTraefikImage(undefined, context)).rejects.toThrow(
		"lock lost",
	);
	expect(mocks.pull).not.toHaveBeenCalled();
});
