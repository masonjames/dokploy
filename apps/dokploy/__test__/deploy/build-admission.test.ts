import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	type BuildAdmissionConfig,
	BuildAdmissionError,
	resolveBuildAdmissionConfig,
	withHostBuildAdmission,
} from "@dokploy/server/utils/process/build-admission";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

const sha256 = async (path: string) =>
	createHash("sha256")
		.update(await readFile(path))
		.digest("hex");

const waitForText = async (path: string, expected: string) => {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (existsSync(path) && (await readFile(path, "utf8")).includes(expected)) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${expected}`);
};

const createFixture = async ({ deny = false }: { deny?: boolean } = {}) => {
	const root = await mkdtemp(join(tmpdir(), "dokploy-build-admission-"));
	temporaryDirectories.push(root);
	const gatePath = join(root, "gate.sh");
	const countPath = join(root, "gate-count");
	const tempRoot = join(root, "tmp");
	await mkdir(tempRoot);
	await writeFile(countPath, "0\n");
	await writeFile(
		gatePath,
		`#!/bin/sh
set -eu
count=$(cat ${shellQuote(countPath)})
printf '%s\n' "$((count + 1))" > ${shellQuote(countPath)}
${deny ? 'echo "DENY fixture pressure" >&2; exit 1' : 'echo "ALLOW filesystem=/host used_percent=50 available_bytes=20000000000"'}
echo "DOKPLOY_BUILD_ADMISSION=allowed"
echo "DOKPLOY_BUILD_GATE_NAMESPACE=host"
`,
	);
	await chmod(gatePath, 0o755);

	const config: BuildAdmissionConfig = {
		mode: "required",
		gatePath,
		gateSha256: await sha256(gatePath),
		lockPath: join(root, "build.lock"),
		tempRoot,
		hostRootMount: "/fixture-host-root",
		waitSeconds: 1,
		readyTimeoutGraceSeconds: 0,
		gateEnvironment: {},
	};
	return { config, countPath };
};

const createAdapterFixture = async ({
	namespaceMode = "host",
	dockerMountOptions = "ro",
}: {
	namespaceMode?: "container" | "host";
	dockerMountOptions?: "ro" | "rw";
} = {}) => {
	const root = await mkdtemp(join(tmpdir(), "dokploy-capacity-adapter-"));
	temporaryDirectories.push(root);
	const platformRoot = join(root, "platform-infra");
	const scripts = join(platformRoot, "ops", "scripts");
	const generated = join(platformRoot, "apps", "monitoring", "generated");
	const fakeBin = join(root, "bin");
	await Promise.all([
		mkdir(scripts, { recursive: true }),
		mkdir(generated, { recursive: true }),
		mkdir(fakeBin),
	]);

	const gatePath = join(scripts, "dokploy-build-capacity-gate.sh");
	const policyPath = join(generated, "platform-capacity-policy.json");
	const dockerPath = join(fakeBin, "docker");
	const findmntPath = join(fakeBin, "findmnt");
	const mountpointPath = join(fakeBin, "mountpoint");
	const hostRoot =
		namespaceMode === "container" ? join(root, "host-root") : "/";
	const dockerRoot = namespaceMode === "container" ? "/docker-root" : "/tmp";
	if (namespaceMode === "container") {
		await mkdir(join(hostRoot, dockerRoot.slice(1)), { recursive: true });
	}
	await writeFile(
		findmntPath,
		`#!/bin/sh
set -eu
[ "$1" = -n ] && [ "$2" = -o ] && [ "$4" = -T ] || exit 2
case "$3:$5" in
	OPTIONS:"$FIXTURE_HOST_ROOT") echo ro ;;
	OPTIONS:*) echo "$FIXTURE_DOCKER_OPTIONS" ;;
	FSROOT:*) echo / ;;
	*) exit 2 ;;
esac
`,
	);
	await chmod(findmntPath, 0o755);
	await writeFile(mountpointPath, "#!/bin/sh\nexit 0\n");
	await chmod(mountpointPath, 0o755);
	await writeFile(
		dockerPath,
		`#!/bin/sh
[ "$1" = info ] || exit 2
echo ${shellQuote(dockerRoot)}
`,
	);
	await chmod(dockerPath, 0o755);
	await writeFile(
		gatePath,
		'#!/bin/sh\necho "DOKPLOY_BUILD_ADMISSION=allowed"\n',
	);
	await chmod(gatePath, 0o755);
	await writeFile(policyPath, '{"fixture":true}\n');

	const adapterPath = join(
		process.cwd(),
		"docker",
		"build-admission",
		"host-capacity-gate",
	);
	const dfAdapterPath = join(process.cwd(), "docker", "build-admission", "df");
	return {
		adapterPath,
		environment: {
			...process.env,
			PATH: `${fakeBin}:${process.env.PATH || ""}`,
			FIXTURE_HOST_ROOT: hostRoot,
			FIXTURE_DOCKER_OPTIONS: dockerMountOptions,
			DOKPLOY_BUILD_GATE_NAMESPACE_MODE: namespaceMode,
			DOKPLOY_BUILD_HOST_ROOT_MOUNT: hostRoot,
			DOKPLOY_PLATFORM_CAPACITY_GATE_PATH: gatePath,
			DOKPLOY_PLATFORM_CAPACITY_GATE_SHA256: await sha256(gatePath),
			DOKPLOY_PLATFORM_CAPACITY_POLICY_PATH: policyPath,
			DOKPLOY_PLATFORM_CAPACITY_POLICY_SHA256: await sha256(policyPath),
			DOKPLOY_BUILD_DF_ADAPTER_PATH: dfAdapterPath,
			DOKPLOY_BUILD_DF_ADAPTER_SHA256: await sha256(dfAdapterPath),
		},
	};
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("host build admission", () => {
	it("keeps disabled mode gate-free while using private command staging", async () => {
		const fakeCredential = "disabled-mode-fixture-credential";
		const result = await withHostBuildAdmission(
			{
				serverId: null,
				operation: "disabled-fixture",
				config: resolveBuildAdmissionConfig({ NODE_ENV: "test" }),
			},
			async ({ prepareCommand }) => {
				const tempWrapper = await prepareCommand(
					'printf "%s" "$DOKPLOY_BUILD_TMPDIR"',
				);
				expect(tempWrapper).not.toContain("printf");
				const directory = (await execFileAsync("/bin/sh", ["-c", tempWrapper]))
					.stdout;

				const secretWrapper = await prepareCommand(
					`printf '%s' ${shellQuote(fakeCredential)}`,
				);
				expect(secretWrapper).not.toContain(fakeCredential);
				const scripts = (await readdir(directory)).filter((name) =>
					name.startsWith("command-"),
				);
				expect(scripts).toHaveLength(1);
				const scriptPath = join(directory, scripts[0] as string);
				expect((await stat(scriptPath)).mode & 0o777).toBe(0o600);
				expect(
					(await execFileAsync("/bin/sh", ["-c", secretWrapper])).stdout,
				).toBe(fakeCredential);
				expect(existsSync(scriptPath)).toBe(false);
				return directory;
			},
		);
		expect(result).toContain("dokploy-command.");
		expect(existsSync(result)).toBe(false);
	});

	it("fails configuration closed when required inputs are missing", () => {
		expect(() =>
			resolveBuildAdmissionConfig({
				NODE_ENV: "test",
				DOKPLOY_BUILD_ADMISSION_MODE: "required",
			}),
		).toThrow(BuildAdmissionError);
		expect(() =>
			resolveBuildAdmissionConfig({
				NODE_ENV: "test",
				DOKPLOY_BUILD_ADMISSION_MODE: "required",
				DOKPLOY_BUILD_CAPACITY_GATE_PATH: "/gate",
				DOKPLOY_BUILD_CAPACITY_GATE_SHA256: "a".repeat(63),
				DOKPLOY_BUILD_HOST_ROOT_MOUNT: "/host",
			}),
		).toThrow("lowercase SHA-256 digest");
		expect(() =>
			resolveBuildAdmissionConfig({
				NODE_ENV: "test",
				DOKPLOY_BUILD_ADMISSION_MODE: "required",
				DOKPLOY_BUILD_CAPACITY_GATE_PATH: "/gate",
				DOKPLOY_BUILD_CAPACITY_GATE_SHA256: "a".repeat(64),
				DOKPLOY_BUILD_HOST_ROOT_MOUNT: "/host/../root",
			}),
		).toThrow("normalized");
		expect(() =>
			resolveBuildAdmissionConfig({
				NODE_ENV: "test",
				DOKPLOY_BUILD_ADMISSION_MODE: "required",
				DOKPLOY_BUILD_CAPACITY_GATE_PATH: "/gate",
				DOKPLOY_BUILD_CAPACITY_GATE_SHA256: "a".repeat(64),
				DOKPLOY_BUILD_HOST_ROOT_MOUNT: "/host",
				DOKPLOY_BUILD_LOCK_WAIT_SECONDS: "1.5",
			}),
		).toThrow("whole number");
	});

	it("requires exact 64-character adapter, gate, and policy hashes", async () => {
		const { adapterPath, environment } = await createAdapterFixture();
		const allowed = await execFileAsync("/bin/sh", [adapterPath], {
			env: environment,
		});
		expect(allowed.stdout).toContain("DOKPLOY_BUILD_ADMISSION=allowed");
		expect(allowed.stdout).toContain("DOKPLOY_BUILD_GATE_NAMESPACE=host");

		await expect(
			execFileAsync("/bin/sh", [adapterPath], {
				env: {
					...environment,
					DOKPLOY_PLATFORM_CAPACITY_GATE_SHA256:
						environment.DOKPLOY_PLATFORM_CAPACITY_GATE_SHA256.slice(1),
				},
			}),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("exactly 64 characters"),
		});
	});

	it("fails before policy resolution when readlink is unavailable", async () => {
		const { adapterPath, environment } = await createAdapterFixture();
		const fakeBin = environment.PATH.split(":")[0] as string;
		const awkPath = join(fakeBin, "awk");
		const bashPath = join(fakeBin, "bash");
		await writeFile(awkPath, '#!/bin/sh\nexec /usr/bin/awk "$@"\n');
		await chmod(awkPath, 0o755);
		await writeFile(bashPath, '#!/bin/sh\nexec /bin/bash "$@"\n');
		await chmod(bashPath, 0o755);

		await expect(
			execFileAsync("/bin/sh", [adapterPath], {
				env: { ...environment, PATH: fakeBin },
			}),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("missing command: readlink"),
		});
	});

	it("rejects a writable nested DockerRootDir mount", async () => {
		const readOnly = await createAdapterFixture({ namespaceMode: "container" });
		await expect(
			execFileAsync("/bin/sh", [readOnly.adapterPath], {
				env: readOnly.environment,
			}),
		).resolves.toMatchObject({
			stdout: expect.stringContaining("DOKPLOY_BUILD_GATE_NAMESPACE=host"),
		});

		const writable = await createAdapterFixture({
			namespaceMode: "container",
			dockerMountOptions: "rw",
		});
		await expect(
			execFileAsync("/bin/sh", [writable.adapterPath], {
				env: writable.environment,
			}),
		).rejects.toMatchObject({
			stderr: expect.stringContaining("DockerRootDir mount must be read-only"),
		});
	});

	it("holds one lock across commands and cleans the private temp directory", async () => {
		const { config } = await createFixture();
		let buildTemp = "";

		await withHostBuildAdmission(
			{ serverId: null, operation: "two-phase-fixture", config },
			async ({ prepareCommand }) => {
				const first = await execFileAsync("/bin/sh", [
					"-c",
					await prepareCommand('printf "%s" "$DOKPLOY_BUILD_TMPDIR"'),
				]);
				buildTemp = first.stdout;
				expect(existsSync(buildTemp)).toBe(true);

				await expect(
					execFileAsync("flock", ["--nonblock", config.lockPath, "true"]),
				).rejects.toBeDefined();

				await execFileAsync("/bin/sh", [
					"-c",
					await prepareCommand('test "$TMPDIR" = "$DOKPLOY_BUILD_TMPDIR"'),
				]);
			},
		);

		expect(existsSync(buildTemp)).toBe(false);
		await expect(
			execFileAsync("flock", ["--nonblock", config.lockPath, "true"]),
		).resolves.toBeDefined();
	});

	it("keeps reversible payloads out of argv in a private 0600 script", async () => {
		const { config } = await createFixture();
		const fakeCredential = "fixture-token-do-not-expose-in-argv";
		let scriptPath = "";

		await withHostBuildAdmission(
			{ serverId: null, operation: "private-script-fixture", config },
			async ({ prepareCommand }) => {
				const wrapper = await prepareCommand(
					`FAKE_CREDENTIAL=${shellQuote(fakeCredential)}; export FAKE_CREDENTIAL; printf '%s' "$FAKE_CREDENTIAL"`,
				);
				expect(wrapper).not.toContain(fakeCredential);

				const buildDirectories = (await readdir(config.tempRoot)).filter(
					(name) => name.startsWith("build-"),
				);
				expect(buildDirectories).toHaveLength(1);
				const buildDirectory = join(
					config.tempRoot,
					buildDirectories[0] as string,
				);
				const scripts = (await readdir(buildDirectory)).filter((name) =>
					name.startsWith("command-"),
				);
				expect(scripts).toHaveLength(1);
				scriptPath = join(buildDirectory, scripts[0] as string);
				expect((await stat(scriptPath)).mode & 0o777).toBe(0o600);
				expect(await readFile(scriptPath, "utf8")).toContain(fakeCredential);

				const executed = await execFileAsync("/bin/sh", ["-c", wrapper]);
				expect(executed.stdout).toBe(fakeCredential);
				expect(existsSync(scriptPath)).toBe(false);
			},
		);

		expect(existsSync(scriptPath)).toBe(false);
	});

	it("removes the prior valid owner's stale temp only after ownership drain", async () => {
		const { config } = await createFixture();
		const priorOwner = "a".repeat(32);
		const staleTemp = join(config.tempRoot, `build-${priorOwner}`);
		await mkdir(staleTemp);
		await writeFile(join(staleTemp, "id_rsa"), "fixture-private-key");
		await writeFile(`${config.lockPath}.owner`, `${priorOwner}\n`);

		await withHostBuildAdmission(
			{ serverId: null, operation: "stale-temp-fixture", config },
			async () => {
				expect(existsSync(staleTemp)).toBe(false);
			},
		);
	});

	it("blocks a competing owner until a superseded command is reaped", async () => {
		const { config } = await createFixture();
		const eventsPath = join(config.tempRoot, "ownership-events");
		const ownerTokenPath = `${config.lockPath}.owner`;
		const commandLockPath = `${config.lockPath}.commands`;
		let competitor: Promise<unknown> | undefined;

		await expect(
			withHostBuildAdmission(
				{ serverId: null, operation: "ownership-loss-fixture", config },
				async ({ prepareCommand }) => {
					const owned = execFileAsync("/bin/sh", [
						"-c",
						await prepareCommand(`
trap 'printf "child-stopped\\n" >> ${shellQuote(eventsPath)}; exit 143' TERM
printf "child-started\\n" >> ${shellQuote(eventsPath)}
while true; do
	printf "child-write\\n" >> ${shellQuote(eventsPath)}
	sleep 0.05
done
`),
					]);
					await waitForText(eventsPath, "child-started");
					competitor = execFileAsync("flock", [
						"--exclusive",
						commandLockPath,
						"/bin/sh",
						"-c",
						`printf "competitor-entered\\n" >> ${shellQuote(eventsPath)}`,
					]);
					await writeFile(ownerTokenPath, "replacement-owner\n");
					await owned;
				},
			),
		).rejects.toBeDefined();
		await competitor;

		const events = (await readFile(eventsPath, "utf8")).trim().split("\n");
		expect(events).toContain("child-stopped");
		expect(events.at(-1)).toBe("competitor-entered");
	});

	it("runs a fresh capacity gate for a retry", async () => {
		const { config, countPath } = await createFixture();
		for (const operation of ["first-attempt", "retry-attempt"]) {
			await withHostBuildAdmission(
				{ serverId: null, operation, config },
				async ({ prepareCommand }) => {
					await execFileAsync("/bin/sh", ["-c", await prepareCommand("true")]);
				},
			);
		}
		expect((await readFile(countPath, "utf8")).trim()).toBe("2");
	});

	it("does not terminate a build after the acquisition timeout is cleared", async () => {
		const { config } = await createFixture();
		await expect(
			withHostBuildAdmission(
				{ serverId: null, operation: "long-running-fixture", config },
				async ({ prepareCommand }) => {
					await execFileAsync("/bin/sh", [
						"-c",
						await prepareCommand("sleep 1.2; true"),
					]);
					return "complete";
				},
			),
		).resolves.toBe("complete");
	});

	it("does not enter the build callback when the gate denies", async () => {
		const { config, countPath } = await createFixture({ deny: true });
		let entered = false;
		await expect(
			withHostBuildAdmission(
				{ serverId: null, operation: "denied-fixture", config },
				async () => {
					entered = true;
				},
			),
		).rejects.toThrow("Build admission failed before lock acquisition");
		expect(entered).toBe(false);
		expect((await readFile(countPath, "utf8")).trim()).toBe("1");
	});

	it("rejects custom local Docker endpoint environments in required mode", async () => {
		const { config } = await createFixture();
		const endpointEnvironments = [
			{ DOKPLOY_DOCKER_HOST: "tcp://other-daemon:2375", NODE_ENV: "test" },
			{ DOCKER_CONTEXT: "other-context", NODE_ENV: "test" },
			{ DOCKER_HOST: "tcp://other-daemon:2375", NODE_ENV: "test" },
		] as const;
		for (const environment of endpointEnvironments) {
			let entered = false;
			await expect(
				withHostBuildAdmission(
					{
						config,
						environment,
						operation: "custom-docker-endpoint-fixture",
						serverId: null,
					},
					async () => {
						entered = true;
					},
				),
			).rejects.toThrow("cannot verify a custom Docker endpoint");
			expect(entered).toBe(false);
		}
	});
});
