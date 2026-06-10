import { beforeEach, expect, test, vi } from "vitest";

const dockerMock = vi.hoisted(() => ({
	getContainer: vi.fn(),
	getService: vi.fn(),
	listTasks: vi.fn(),
}));

vi.mock("@dokploy/server/constants", () => ({
	docker: dockerMock,
	paths: vi.fn(() => ({})),
}));

import {
	checkTraefikHealth,
	checkWebServerHealth,
} from "@dokploy/server/utils/docker/utils";

beforeEach(() => {
	vi.clearAllMocks();
	dockerMock.getContainer.mockReturnValue({
		inspect: vi.fn().mockResolvedValue({ State: { Running: true } }),
	});
	dockerMock.getService.mockReturnValue({
		inspect: vi.fn().mockResolvedValue({
			Spec: { Mode: { Replicated: { Replicas: 1 } } },
		}),
	});
	dockerMock.listTasks.mockResolvedValue([
		{
			Status: {
				State: "running",
				ContainerStatus: { ContainerID: "container-1" },
			},
		},
	]);
});

test("checks the provider's docker resource and reports the provider", async () => {
	const result = await checkWebServerHealth("traefik");

	expect(result).toEqual({ provider: "traefik", status: "healthy" });
	expect(dockerMock.getContainer).toHaveBeenCalledWith("dokploy-traefik");
	expect(dockerMock.getService).not.toHaveBeenCalled();
});

test("falls back to the swarm service when no standalone container exists", async () => {
	dockerMock.getContainer.mockReturnValueOnce({
		inspect: vi.fn().mockRejectedValue(new Error("missing container")),
	});

	const result = await checkWebServerHealth("traefik");

	expect(result).toEqual({ provider: "traefik", status: "healthy" });
	expect(dockerMock.getService).toHaveBeenCalledWith("dokploy-traefik");
	expect(dockerMock.listTasks).toHaveBeenCalledWith({
		filters: JSON.stringify({
			service: ["dokploy-traefik"],
			"desired-state": ["running"],
		}),
	});
});

test("reports unhealthy when the container is not running", async () => {
	dockerMock.getContainer.mockReturnValueOnce({
		inspect: vi.fn().mockResolvedValue({ State: { Running: false } }),
	});

	const result = await checkWebServerHealth("traefik");

	expect(result).toEqual({
		provider: "traefik",
		status: "unhealthy",
		message: "Container is not running",
	});
});

test("keeps the Traefik-specific helper behavior unchanged", async () => {
	dockerMock.getContainer.mockReturnValueOnce({
		inspect: vi.fn().mockResolvedValue({ State: { Running: false } }),
	});

	const result = await checkTraefikHealth();

	expect(result).toEqual({
		status: "unhealthy",
		message: "Container is not running",
	});
	expect(dockerMock.getContainer).toHaveBeenCalledWith("dokploy-traefik");
});
