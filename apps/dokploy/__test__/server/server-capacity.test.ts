import {
	buildServerCapacityCommand,
	parseServerCapacityOutput,
} from "@dokploy/server/services/server-capacity";
import { describe, expect, it } from "vitest";

describe("server capacity evidence", () => {
	it("measures root and DockerRootDir for bytes and inodes", () => {
		const command = buildServerCapacityCommand();
		expect(command).toContain("docker info --format '{{.DockerRootDir}}'");
		expect(command).toContain("df -Pk");
		expect(command).toContain("df -Pi");
	});

	it("parses complete capacity evidence", () => {
		const report = parseServerCapacityOutput(
			"server-test",
			[
				"DOKPLOY_CAPACITY_V1\thostname\te2e-worker-123",
				"DOKPLOY_CAPACITY_V1\troot\t100000 40000 60000 40%\t1000 100 900 10%",
				"DOKPLOY_CAPACITY_V1\tdocker\t200000 50000 150000 25%\t2000 200 1800 10%",
			].join("\n"),
		);

		expect(report.hostname).toBe("e2e-worker-123");
		expect(report.filesystems).toHaveLength(2);
		expect(report.filesystems[0]).toMatchObject({
			scope: "root",
			availableBytes: 60_000 * 1024,
			availableInodes: 900,
		});
	});

	it("fails closed on incomplete evidence", () => {
		expect(() =>
			parseServerCapacityOutput(
				"server-test",
				"DOKPLOY_CAPACITY_V1\thostname\te2e-worker-123",
			),
		).toThrow("incomplete");
	});
});
