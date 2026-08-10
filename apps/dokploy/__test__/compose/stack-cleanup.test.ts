import {
	buildStackCleanupCommand,
	parseStackCleanupOutput,
} from "@dokploy/server/utils/docker/stack-cleanup";
import { describe, expect, it } from "vitest";

describe("stack cleanup", () => {
	it("enumerates only stack-labeled volumes and removes each exact name", () => {
		const command = buildStackCleanupCommand({
			stackName: "e2e-uptime-kuma-abcd",
			deleteVolumes: true,
		});

		expect(command).toContain("com.docker.stack.namespace=$_dokploy_stack");
		expect(command).toContain(
			'docker volume ls --filter "label=$_dokploy_label"',
		);
		expect(command).toContain(
			'docker ps -aq --filter "volume=$_dokploy_volume"',
		);
		expect(command).toContain('docker volume rm -- "$_dokploy_volume"');
		expect(command).not.toContain("docker volume prune");
		expect(command).not.toContain("docker system prune");
	});

	it("retains labeled volumes when deleteVolumes is false", () => {
		const command = buildStackCleanupCommand({
			stackName: "retain-me",
			deleteVolumes: false,
		});

		expect(command).toContain("_dokploy_delete_volumes=0");
		expect(command).toContain("DOKPLOY_STACK_CLEANUP_RETAINED_VOLUME");
	});

	it("disconnects and removes an isolated external stack network", () => {
		const command = buildStackCleanupCommand({
			stackName: "isolated-e2e",
			deleteVolumes: true,
			isolatedDeployment: true,
		});

		expect(command).toContain("_dokploy_isolated=1");
		expect(command).toContain(
			'docker network disconnect -f "$_dokploy_stack" "$_dokploy_container"',
		);
		expect(command).toContain('docker network rm "$_dokploy_stack"');
		expect(command).toContain(
			"docker network inspect --format '{{.ID}}' \"$_dokploy_stack\"",
		);
	});

	it("rejects unsafe stack names before constructing a shell command", () => {
		expect(() =>
			buildStackCleanupCommand({
				stackName: "valid; docker system prune",
				deleteVolumes: true,
			}),
		).toThrow("not safe");
	});

	it("parses bounded verification evidence", () => {
		const report = parseStackCleanupOutput({
			stackName: "e2e-test",
			deleteVolumes: true,
			stdout: [
				"DOKPLOY_STACK_CLEANUP_DISCOVERED_VOLUME=e2e-test_data",
				"DOKPLOY_STACK_CLEANUP_REMOVED_VOLUME=e2e-test_data",
				"DOKPLOY_STACK_CLEANUP_VERIFIED=1",
			].join("\n"),
		});

		expect(report).toMatchObject({
			kind: "stack",
			stackName: "e2e-test",
			deleteVolumes: true,
			discoveredVolumes: ["e2e-test_data"],
			removedVolumes: ["e2e-test_data"],
			verified: true,
		});
		expect(report.residualVolumes).toEqual([]);
	});

	it("preserves residual identifiers from an unverified command result", () => {
		const report = parseStackCleanupOutput({
			stackName: "e2e-test",
			deleteVolumes: true,
			stdout: [
				"DOKPLOY_STACK_CLEANUP_RESIDUAL_SERVICE=service-1",
				"DOKPLOY_STACK_CLEANUP_RESIDUAL_CONTAINER=container-1",
				"DOKPLOY_STACK_CLEANUP_RESIDUAL_NETWORK=network-1",
				"DOKPLOY_STACK_CLEANUP_RESIDUAL_VOLUME=volume-1",
			].join("\n"),
		});

		expect(report).toMatchObject({
			residualServices: ["service-1"],
			residualContainers: ["container-1"],
			residualNetworks: ["network-1"],
			residualVolumes: ["volume-1"],
			verified: false,
		});
	});
});
