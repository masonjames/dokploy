import * as composeBuilder from "@dokploy/server/utils/builders/compose";
import * as domainUtils from "@dokploy/server/utils/docker/domain";
import * as buildAdmission from "@dokploy/server/utils/process/build-admission";
import * as execProcess from "@dokploy/server/utils/process/execAsync";
import { beforeEach, describe, expect, it, vi } from "vitest";

let admissionDepth = 0;

vi.mock("@dokploy/server/db", () => {
	const chain = {
		set: vi.fn(),
		where: vi.fn(),
		returning: vi.fn(),
	};
	chain.set.mockReturnValue(chain);
	chain.where.mockReturnValue(chain);
	chain.returning.mockResolvedValue([{}]);
	return {
		db: {
			query: { compose: { findFirst: vi.fn() } },
			update: vi.fn(() => chain),
		},
	};
});

vi.mock("@dokploy/server/utils/builders/compose", () => ({
	getBuildComposeCommand: vi.fn(),
}));

vi.mock("@dokploy/server/utils/docker/domain", () => ({
	cloneCompose: vi.fn(),
	loadDockerCompose: vi.fn(),
	loadDockerComposeRemote: vi.fn(),
	getCaddyComposeRouteTargetsForWebServer: vi.fn(async () => {
		expect(admissionDepth).toBe(1);
		return [{ finalServiceName: "web", domain: { domainId: "domain-id" } }];
	}),
	writeCaddyComposeRoutesForTargets: vi.fn(async () => {
		expect(admissionDepth).toBe(0);
	}),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(async () => {
		expect(admissionDepth).toBe(1);
		return { stdout: "", stderr: "" };
	}),
	execAsyncRemote: vi.fn(),
	ExecError: class ExecError extends Error {},
}));

vi.mock("@dokploy/server/utils/process/build-admission", () => ({
	withHostBuildAdmission: vi.fn(async (_options, callback) => {
		admissionDepth += 1;
		try {
			const signal = new AbortController().signal;
			return await callback({
				prepareCommand: async (command: string) => `ADMITTED:${command}`,
				signal,
				assertLockHeld: () => undefined,
			});
		} finally {
			admissionDepth -= 1;
		}
	}),
}));

vi.mock("@dokploy/server/services/admin", () => ({
	getDokployUrl: vi.fn().mockResolvedValue("https://dokploy.example.test"),
}));

vi.mock("@dokploy/server/services/deployment", () => ({
	createDeploymentCompose: vi.fn().mockResolvedValue({
		deploymentId: "deployment-id",
		logPath: "/tmp/compose-deployment.log",
	}),
	updateDeployment: vi.fn(),
	updateDeploymentStatus: vi.fn(),
}));

vi.mock("@dokploy/server/utils/notifications/build-success", () => ({
	sendBuildSuccessNotifications: vi.fn(),
}));

vi.mock("@dokploy/server/utils/notifications/build-error", () => ({
	sendBuildErrorNotifications: vi.fn(),
}));

vi.mock("@dokploy/server/utils/providers/git", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/providers/git")
	>("@dokploy/server/utils/providers/git");
	return { ...actual, getGitCommitInfo: vi.fn() };
});

import { db } from "@dokploy/server/db";
import { deployCompose, startCompose } from "@dokploy/server/services/compose";

const composeFixture = {
	composeId: "compose-id",
	name: "Test Compose",
	appName: "test-compose",
	description: "",
	sourceType: "raw" as const,
	composeType: "docker-compose" as const,
	composeFile: "services:\n  web:\n    image: nginx:alpine\n",
	composePath: "docker-compose.yml",
	command: null,
	env: "",
	randomize: false,
	suffix: "",
	isolatedDeployment: false,
	isolatedDeploymentsVolume: false,
	serverId: null,
	environmentId: "environment-id",
	environment: {
		name: "production",
		env: "",
		projectId: "project-id",
		project: {
			name: "Project",
			env: "",
			organizationId: "organization-id",
		},
	},
	domains: [],
	mounts: [],
};

describe("compose host build admission", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		admissionDepth = 0;
		vi.mocked(db.query.compose.findFirst).mockResolvedValue(
			composeFixture as never,
		);
		vi.mocked(composeBuilder.getBuildComposeCommand).mockResolvedValue(
			"docker compose up -d --build",
		);
	});

	it("holds one admission callback across clone materialization and build", async () => {
		await deployCompose({
			composeId: "compose-id",
			titleLog: "Test deployment",
			descriptionLog: "",
		});

		expect(buildAdmission.withHostBuildAdmission).toHaveBeenCalledTimes(1);
		expect(buildAdmission.withHostBuildAdmission).toHaveBeenCalledWith(
			expect.objectContaining({ operation: "compose-deploy", serverId: null }),
			expect.any(Function),
		);

		const executed = vi.mocked(execProcess.execAsync).mock.calls;
		expect(executed).toHaveLength(2);
		expect(executed[0]?.[0]).toMatch(/^ADMITTED:/);
		expect(executed[0]?.[0]).toContain("docker-compose.yml");
		expect(executed[1]?.[0]).toMatch(/^ADMITTED:/);
		expect(executed[1]?.[0]).toContain("docker compose up -d --build");
		expect(
			domainUtils.getCaddyComposeRouteTargetsForWebServer,
		).toHaveBeenCalledOnce();
		expect(
			domainUtils.writeCaddyComposeRoutesForTargets,
		).toHaveBeenCalledOnce();
		expect(admissionDepth).toBe(0);
	});

	it("admits compose start because up can pull missing images", async () => {
		await startCompose("compose-id");

		expect(buildAdmission.withHostBuildAdmission).toHaveBeenCalledOnce();
		expect(buildAdmission.withHostBuildAdmission).toHaveBeenCalledWith(
			{ operation: "compose-start", serverId: null },
			expect.any(Function),
		);
		expect(execProcess.execAsync).toHaveBeenCalledWith(
			expect.stringMatching(/^ADMITTED:.*docker compose .* up -d$/),
			expect.objectContaining({
				cwd: expect.stringContaining("test-compose/code"),
				signal: expect.anything(),
			}),
		);
		expect(admissionDepth).toBe(0);
	});
});
