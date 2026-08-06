import type { ApplicationNested } from "@dokploy/server/utils/builders";
import { mechanizeDockerContainer } from "@dokploy/server/utils/builders";
import type { BuildAdmissionContext } from "@dokploy/server/utils/process/build-admission";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockCreateServiceOptions = {
	TaskTemplate?: {
		ContainerSpec?: {
			StopGracePeriod?: number;
			Ulimits?: Array<{ Name: string; Soft: number; Hard: number }>;
		};
	};
	[key: string]: unknown;
};

type MockServiceInspect = {
	Spec: { TaskTemplate: { ForceUpdate: number } };
	Version: { Index: string };
};

const {
	inspectMock,
	updateMock,
	getServiceMock,
	createServiceMock,
	getRemoteDockerMock,
} = vi.hoisted(() => {
	const inspect = vi.fn<() => Promise<MockServiceInspect>>();
	const update = vi.fn<() => Promise<void>>(async () => undefined);
	const getService = vi.fn(() => ({ inspect, update }));
	const createService = vi.fn<
		(opts: MockCreateServiceOptions) => Promise<void>
	>(async () => undefined);
	const getRemoteDocker = vi.fn(async () => ({
		getService,
		createService,
	}));
	return {
		inspectMock: inspect,
		updateMock: update,
		getServiceMock: getService,
		createServiceMock: createService,
		getRemoteDockerMock: getRemoteDocker,
	};
});

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: getRemoteDockerMock,
}));

const createApplication = (
	overrides: Partial<ApplicationNested> = {},
): ApplicationNested =>
	({
		appName: "test-app",
		buildType: "dockerfile",
		env: null,
		mounts: [],
		cpuLimit: null,
		memoryLimit: null,
		memoryReservation: null,
		cpuReservation: null,
		command: null,
		ports: [],
		sourceType: "docker",
		dockerImage: "example:latest",
		registry: null,
		environment: {
			project: { env: null },
			env: null,
		},
		replicas: 1,
		stopGracePeriodSwarm: 0,
		ulimitsSwarm: null,
		serverId: "server-id",
		...overrides,
	}) as unknown as ApplicationNested;

const assertLockHeldMock = vi.fn();
const buildAdmissionContext: BuildAdmissionContext = {
	assertLockHeld: assertLockHeldMock,
	prepareCommand: vi.fn(async (command: string) => command),
	signal: new AbortController().signal,
};

describe("mechanizeDockerContainer", () => {
	beforeEach(() => {
		inspectMock.mockReset();
		inspectMock.mockRejectedValue(new Error("service not found"));
		updateMock.mockReset();
		updateMock.mockResolvedValue(undefined);
		getServiceMock.mockClear();
		createServiceMock.mockClear();
		getRemoteDockerMock.mockClear();
		getRemoteDockerMock.mockResolvedValue({
			getService: getServiceMock,
			createService: createServiceMock,
		});
		assertLockHeldMock.mockReset();
	});

	it("passes stopGracePeriodSwarm as a number and keeps zero values", async () => {
		const application = createApplication({ stopGracePeriodSwarm: 0 });

		await mechanizeDockerContainer(application, buildAdmissionContext);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0] as
			| [MockCreateServiceOptions]
			| undefined;
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec?.StopGracePeriod).toBe(0);
		expect(typeof settings.TaskTemplate?.ContainerSpec?.StopGracePeriod).toBe(
			"number",
		);
	});

	it("omits StopGracePeriod when stopGracePeriodSwarm is null", async () => {
		const application = createApplication({ stopGracePeriodSwarm: null });

		await mechanizeDockerContainer(application, buildAdmissionContext);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0] as
			| [MockCreateServiceOptions]
			| undefined;
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec).not.toHaveProperty(
			"StopGracePeriod",
		);
	});

	it("passes ulimits to ContainerSpec when ulimitsSwarm is defined", async () => {
		const ulimits = [
			{ Name: "nofile", Soft: 10000, Hard: 20000 },
			{ Name: "nproc", Soft: 4096, Hard: 8192 },
		];
		const application = createApplication({ ulimitsSwarm: ulimits });

		await mechanizeDockerContainer(application, buildAdmissionContext);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0];
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec?.Ulimits).toEqual(ulimits);
	});

	it("omits Ulimits when ulimitsSwarm is null", async () => {
		const application = createApplication({ ulimitsSwarm: null });

		await mechanizeDockerContainer(application, buildAdmissionContext);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0];
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec).not.toHaveProperty("Ulimits");
	});

	it("omits Ulimits when ulimitsSwarm is an empty array", async () => {
		const application = createApplication({ ulimitsSwarm: [] });

		await mechanizeDockerContainer(application, buildAdmissionContext);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0];
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec).not.toHaveProperty("Ulimits");
	});

	it("does not create a replacement when admission is lost during update", async () => {
		const lockLoss = new Error("host build lock was lost");
		let lockLost = false;
		inspectMock.mockResolvedValue({
			Spec: { TaskTemplate: { ForceUpdate: 0 } },
			Version: { Index: "1" },
		});
		updateMock.mockImplementation(async () => {
			lockLost = true;
			throw new Error("update interrupted");
		});
		assertLockHeldMock.mockImplementation(() => {
			if (lockLost) throw lockLoss;
		});

		await expect(
			mechanizeDockerContainer(createApplication(), buildAdmissionContext),
		).rejects.toBe(lockLoss);

		expect(updateMock).toHaveBeenCalledOnce();
		expect(createServiceMock).not.toHaveBeenCalled();
	});
});
