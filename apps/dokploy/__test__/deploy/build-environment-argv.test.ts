import { execFile } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getDockerCommand } from "@dokploy/server/utils/builders/docker-file";
import { getHerokuCommand } from "@dokploy/server/utils/builders/heroku";
import { getNixpacksCommand } from "@dokploy/server/utils/builders/nixpacks";
import { getPaketoCommand } from "@dokploy/server/utils/builders/paketo";
import { getRailpackCommand } from "@dokploy/server/utils/builders/railpack";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const fakeValue = "fixture-reversible-token-value";
const fakeSecretValue = "fixture-distinct-build-secret-value";
const fixture = {
	applicationId: "application-id",
	appName: "fixture-app",
	name: "Fixture App",
	serverId: null,
	sourceType: "git",
	customGitBuildPath: "",
	buildPath: "",
	buildType: "nixpacks",
	dockerfile: "Dockerfile",
	dockerContextPath: null,
	dockerBuildStage: null,
	publishDirectory: null,
	cleanCache: false,
	createEnvFile: false,
	env: `API_TOKEN=${fakeValue}`,
	buildArgs: `API_TOKEN=${fakeValue}`,
	buildSecrets: `API_TOKEN=${fakeSecretValue}`,
	herokuVersion: "24",
	railpackVersion: "0.15.4",
	environment: {
		env: "",
		project: { env: "" },
	},
} as any;

const commandLine = (command: string, prefix: string) =>
	command
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.startsWith(prefix));

describe("build environment argv transport", () => {
	it("passes only variable names to Nixpacks, pack, and Railpack", () => {
		const nixpacks = commandLine(getNixpacksCommand(fixture), "nixpacks ");
		expect(nixpacks).toContain("--env API_TOKEN");
		expect(nixpacks).not.toContain(fakeValue);
		expect(nixpacks).not.toContain("API_TOKEN=");

		for (const command of [
			getPaketoCommand(fixture),
			getHerokuCommand(fixture),
		]) {
			const invocation = commandLine(command, "pack ");
			expect(invocation).toContain("--env API_TOKEN");
			expect(invocation).not.toContain(fakeValue);
			expect(invocation).not.toContain("API_TOKEN=");
			expect(invocation).not.toContain("--env-file");
		}

		const railpack = getRailpackCommand(fixture);
		const prepare = commandLine(railpack, "railpack ");
		const build = commandLine(railpack, "docker buildx build");
		expect(prepare).toContain("--env API_TOKEN");
		expect(prepare).not.toContain(fakeValue);
		expect(build).toContain("--secret id=API_TOKEN,env=API_TOKEN");
		expect(build).not.toContain(fakeValue);
	});

	it("uses value-less Docker build args and protected secret files", () => {
		const command = getDockerCommand({
			...fixture,
			buildType: "dockerfile",
		});
		const invocation = commandLine(command, "docker ");
		expect(invocation).toContain("docker build");
		const dockerArgv = invocation;
		expect(dockerArgv).toContain("--build-arg API_TOKEN");
		expect(dockerArgv).not.toContain("--build-arg API_TOKEN=");
		expect(dockerArgv).toContain(
			'--secret type=file,id=API_TOKEN,src="$DOKPLOY_BUILD_TMPDIR/docker-secret-API_TOKEN"',
		);
		expect(dockerArgv).not.toContain(fakeValue);
		expect(dockerArgv).not.toContain(fakeSecretValue);
		expect(command).toContain(`export API_TOKEN=${fakeValue}`);
	});

	it("passes exact multiline pack values through the process environment", async () => {
		const multilineValue = `first line
second $HOME 'single' \`literal\` \\path`;
		const command = getPaketoCommand({
			...fixture,
			env: `API_TOKEN="${multilineValue}"`,
		});
		const directory = await mkdtemp(join(tmpdir(), "dokploy-pack-env."));
		try {
			const binDirectory = join(directory, "bin");
			const capturedEnvironment = join(directory, "environment");
			const capturedArguments = join(directory, "arguments");
			await mkdir(binDirectory);
			const fakePack = join(binDirectory, "pack");
			await writeFile(
				fakePack,
				`#!/bin/sh
set -eu
printf '%s' "$API_TOKEN" > "$DOKPLOY_CAPTURED_ENVIRONMENT"
printf '%s\\n' "$@" > "$DOKPLOY_CAPTURED_ARGUMENTS"
`,
			);
			await chmod(fakePack, 0o700);

			await execFileAsync("/bin/sh", ["-c", command], {
				env: {
					...process.env,
					PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
					DOKPLOY_CAPTURED_ENVIRONMENT: capturedEnvironment,
					DOKPLOY_CAPTURED_ARGUMENTS: capturedArguments,
				},
			});
			expect(await readFile(capturedEnvironment, "utf8")).toBe(multilineValue);
			expect(await readFile(capturedArguments, "utf8")).toContain(
				"--env\nAPI_TOKEN\n",
			);
			expect(await readFile(capturedArguments, "utf8")).not.toContain(
				multilineValue,
			);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	it("keeps overlapping Docker build args and secrets distinct", async () => {
		const command = getDockerCommand({
			...fixture,
			buildType: "dockerfile",
		});
		const setup = command
			.split("\n")
			.map((line) => line.trim())
			.find(
				(line) =>
					line.startsWith("(umask 077;") &&
					line.includes("docker-secret-API_TOKEN"),
			);
		expect(setup).toBeDefined();

		const directory = await mkdtemp(join(tmpdir(), "dokploy-docker-secret."));
		try {
			await execFileAsync("/bin/sh", ["-c", setup as string], {
				env: { ...process.env, DOKPLOY_BUILD_TMPDIR: directory },
			});
			expect(
				await readFile(join(directory, "docker-secret-API_TOKEN"), "utf8"),
			).toBe(fakeSecretValue);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});
