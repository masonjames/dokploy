import { execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";

const providerMocks = vi.hoisted(() => ({
	bitbucketAppPassword: "fixture-bitbucket-app-password-value",
	bitbucketPassword: "fixture-bitbucket-api-token-value",
	bitbucketUsername: "fixture-bitbucket-user",
	findBitbucketById: vi.fn(),
	findGiteaById: vi.fn(),
	findGithubById: vi.fn(),
	findGitlabById: vi.fn(),
	giteaPassword: "fixture-gitea-token-value",
	githubPassword: "fixture-github-token-value",
	gitlabPassword: "fixture-gitlab-token-value",
	updateGitea: vi.fn(),
	updateGitlab: vi.fn(),
}));

vi.mock("@dokploy/server/services/github", () => ({
	findGithubById: providerMocks.findGithubById,
}));

vi.mock("@dokploy/server/services/gitlab", () => ({
	findGitlabById: providerMocks.findGitlabById,
	updateGitlab: providerMocks.updateGitlab,
}));

vi.mock("@dokploy/server/services/gitea", () => ({
	findGiteaById: providerMocks.findGiteaById,
	updateGitea: providerMocks.updateGitea,
}));

vi.mock("@dokploy/server/services/bitbucket", () => ({
	findBitbucketById: providerMocks.findBitbucketById,
}));

vi.mock("octokit", () => ({
	Octokit: class {
		auth = vi.fn(async () => ({ token: providerMocks.githubPassword }));
	},
}));

import { cloneBitbucketRepository } from "@dokploy/server/utils/providers/bitbucket";
import { getAuthenticatedGitCloneCommand } from "@dokploy/server/utils/providers/git-askpass";
import { cloneGiteaRepository } from "@dokploy/server/utils/providers/gitea";
import { cloneGithubRepository } from "@dokploy/server/utils/providers/github";
import { cloneGitlabRepository } from "@dokploy/server/utils/providers/gitlab";

const execFileAsync = promisify(execFile);

interface ProviderFixture {
	cloneUrl: string;
	name: string;
	password: string;
	render: () => Promise<string>;
	username: string;
}

const findGitCloneLine = (command: string) =>
	command
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.startsWith("git clone "));

const getCredentialFragment = (command: string) => {
	const start = command.indexOf(': "${DOKPLOY_BUILD_TMPDIR:');
	if (start === -1) {
		throw new Error(
			"Rendered command does not contain the private Git credential fragment",
		);
	}
	return command.slice(start);
};

const fakeGitScript = `#!/bin/sh
set -eu
printf '%s\n' "$@" > "$DOKPLOY_TEST_GIT_ARGV"
printf '%s' "\${GIT_TERMINAL_PROMPT:-}" > "$DOKPLOY_TEST_TERMINAL_PROMPT"
printf '%s' "\${GIT_ASKPASS_REQUIRE:-}" > "$DOKPLOY_TEST_ASKPASS_REQUIRE"
printf '%s' "\${GIT_CONFIG_COUNT:-}" > "$DOKPLOY_TEST_CONFIG_COUNT"
_dokploy_test_helper=\${GIT_CONFIG_VALUE_1#\!}

printf 'protocol=%s\nhost=%s\n\n' "$DOKPLOY_GIT_EXPECTED_PROTOCOL" "$DOKPLOY_GIT_EXPECTED_HOST" |
	"$_dokploy_test_helper" get > "$DOKPLOY_TEST_CREDENTIAL"
printf 'protocol=https\nhost=attacker.example.test\n\n' |
	"$_dokploy_test_helper" get > "$DOKPLOY_TEST_CROSS_HOST_CREDENTIAL"
printf 'protocol=%s\nhost=%s\npath=other-owner/private-submodule.git\n\n' "$DOKPLOY_GIT_EXPECTED_PROTOCOL" "$DOKPLOY_GIT_EXPECTED_HOST" |
	"$_dokploy_test_helper" get > "$DOKPLOY_TEST_SUBMODULE_CREDENTIAL"

_dokploy_test_mode() {
	if _dokploy_test_value=$(stat -c '%a' "$1" 2>/dev/null); then
		printf '%s\n' "$_dokploy_test_value"
	else
		stat -f '%Lp' "$1"
	fi
}

{
	_dokploy_test_mode "$DOKPLOY_GIT_USERNAME_FILE"
	_dokploy_test_mode "$DOKPLOY_GIT_PASSWORD_FILE"
	_dokploy_test_mode "$_dokploy_test_helper"
} > "$DOKPLOY_TEST_MODES"
`;

describe("authenticated provider clone argv transport", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		providerMocks.findGithubById.mockResolvedValue({
			githubAppId: 1,
			githubInstallationId: "installation-id",
			githubPrivateKey: "private-key",
		});
		providerMocks.findGitlabById.mockResolvedValue({
			accessToken: providerMocks.gitlabPassword,
			expiresAt: Math.floor(Date.now() / 1000) + 3600,
			gitlabUrl: "https://gitlab.example.test",
		});
		providerMocks.findGiteaById.mockResolvedValue({
			accessToken: providerMocks.giteaPassword,
			giteaUrl: "https://gitea.example.test",
		});
		providerMocks.findBitbucketById.mockResolvedValue({
			apiToken: providerMocks.bitbucketPassword,
		});
	});

	const fixtures: ProviderFixture[] = [
		{
			cloneUrl: "https://github.com/fixture-owner/fixture-repo.git",
			name: "GitHub",
			password: providerMocks.githubPassword,
			render: () =>
				cloneGithubRepository({
					appName: "github-fixture",
					branch: "main",
					enableSubmodules: true,
					githubId: "github-id",
					owner: "fixture-owner",
					repository: "fixture-repo",
					serverId: null,
				}),
			username: "oauth2",
		},
		{
			cloneUrl: "https://gitlab.example.test/fixture-owner/fixture-repo.git",
			name: "GitLab",
			password: providerMocks.gitlabPassword,
			render: () =>
				cloneGitlabRepository({
					appName: "gitlab-fixture",
					enableSubmodules: true,
					gitlabBranch: "main",
					gitlabId: "gitlab-id",
					gitlabOwner: "fixture-owner",
					gitlabPathNamespace: "fixture-owner/fixture-repo",
					gitlabRepository: "fixture-repo",
					serverId: null,
				} as Parameters<typeof cloneGitlabRepository>[0]),
			username: "oauth2",
		},
		{
			cloneUrl: "https://gitea.example.test/fixture-owner/fixture-repo.git",
			name: "Gitea",
			password: providerMocks.giteaPassword,
			render: () =>
				cloneGiteaRepository({
					appName: "gitea-fixture",
					enableSubmodules: true,
					giteaBranch: "main",
					giteaId: "gitea-id",
					giteaOwner: "fixture-owner",
					giteaRepository: "fixture-repo",
					serverId: null,
				}),
			username: "oauth2",
		},
		{
			cloneUrl: "https://bitbucket.org/fixture-owner/fixture-repo.git",
			name: "Bitbucket API token",
			password: providerMocks.bitbucketPassword,
			render: () =>
				cloneBitbucketRepository({
					appName: "bitbucket-fixture",
					bitbucketBranch: "main",
					bitbucketId: "bitbucket-id",
					bitbucketOwner: "fixture-owner",
					bitbucketRepository: "fixture-repo",
					enableSubmodules: true,
					serverId: null,
				}),
			username: "x-bitbucket-api-token-auth",
		},
		{
			cloneUrl: "https://bitbucket.org/fixture-owner/fixture-repo.git",
			name: "Bitbucket app password",
			password: providerMocks.bitbucketAppPassword,
			render: () => {
				providerMocks.findBitbucketById.mockResolvedValueOnce({
					appPassword: providerMocks.bitbucketAppPassword,
					bitbucketUsername: providerMocks.bitbucketUsername,
				});
				return cloneBitbucketRepository({
					appName: "bitbucket-app-password-fixture",
					bitbucketBranch: "main",
					bitbucketId: "bitbucket-id",
					bitbucketOwner: "fixture-owner",
					bitbucketRepository: "fixture-repo",
					enableSubmodules: true,
					serverId: null,
				});
			},
			username: providerMocks.bitbucketUsername,
		},
	];

	it.each(fixtures)(
		"keeps $name credentials out of rendered and executed git argv",
		async ({ cloneUrl, password, render, username }) => {
			const command = await render();
			const gitCloneLine = findGitCloneLine(command);
			const normalizedGitCloneLine = gitCloneLine?.replaceAll("\\:", ":");

			expect(gitCloneLine).toBeDefined();
			expect(normalizedGitCloneLine).toContain(cloneUrl);
			expect(gitCloneLine).toContain("--recurse-submodules");
			expect(gitCloneLine).not.toContain(password);
			expect(gitCloneLine).not.toContain(username);
			expect(gitCloneLine).not.toMatch(/https?:\/\/[^/\s]+@/);
			expect(command).toContain("export GIT_CONFIG_KEY_1=credential.helper");
			expect(command).toContain("export GIT_ASKPASS=/bin/false");
			expect(command).toContain("export GIT_ASKPASS_REQUIRE=force");
			expect(command).toContain("export GIT_TERMINAL_PROMPT=0");

			const testRoot = await mkdtemp(
				join(tmpdir(), "dokploy-provider-askpass-"),
			);
			try {
				const binDirectory = join(testRoot, "bin");
				const buildDirectory = join(testRoot, "build-private");
				const captureDirectory = join(testRoot, "capture");
				await mkdir(binDirectory);
				await mkdir(buildDirectory);
				await mkdir(captureDirectory);
				await writeFile(join(binDirectory, "git"), fakeGitScript, {
					mode: 0o700,
				});

				const capture = {
					argv: join(captureDirectory, "argv"),
					askpassRequire: join(captureDirectory, "askpass-require"),
					configCount: join(captureDirectory, "config-count"),
					credential: join(captureDirectory, "credential"),
					crossHostCredential: join(captureDirectory, "cross-host-credential"),
					modes: join(captureDirectory, "modes"),
					submoduleCredential: join(captureDirectory, "submodule-credential"),
					terminalPrompt: join(captureDirectory, "terminal-prompt"),
				};

				await execFileAsync(
					"/bin/sh",
					["-c", `set -e\n${getCredentialFragment(command)}`],
					{
						env: {
							...process.env,
							DOKPLOY_BUILD_TMPDIR: buildDirectory,
							DOKPLOY_TEST_ASKPASS_REQUIRE: capture.askpassRequire,
							DOKPLOY_TEST_CONFIG_COUNT: capture.configCount,
							DOKPLOY_TEST_CREDENTIAL: capture.credential,
							DOKPLOY_TEST_CROSS_HOST_CREDENTIAL: capture.crossHostCredential,
							DOKPLOY_TEST_GIT_ARGV: capture.argv,
							DOKPLOY_TEST_MODES: capture.modes,
							DOKPLOY_TEST_SUBMODULE_CREDENTIAL: capture.submoduleCredential,
							DOKPLOY_TEST_TERMINAL_PROMPT: capture.terminalPrompt,
							PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
						},
					},
				);

				const argv = (await readFile(capture.argv, "utf8"))
					.trimEnd()
					.split("\n");
				const executedArgv = argv.join("\0");
				expect(argv).toContain(cloneUrl);
				expect(argv).toContain("--recurse-submodules");
				expect(executedArgv).not.toContain(password);
				expect(executedArgv).not.toContain(username);
				expect(executedArgv).not.toMatch(/https?:\/\/[^/\s]+@/);
				const expectedCredential = `username=${username}\npassword=${password}\n`;
				expect(await readFile(capture.credential, "utf8")).toBe(
					expectedCredential,
				);
				expect(await readFile(capture.submoduleCredential, "utf8")).toBe(
					expectedCredential,
				);
				expect(await readFile(capture.crossHostCredential, "utf8")).toBe("");
				expect(await readFile(capture.terminalPrompt, "utf8")).toBe("0");
				expect(await readFile(capture.askpassRequire, "utf8")).toBe("force");
				expect(await readFile(capture.configCount, "utf8")).toBe("3");
				expect(
					(await readFile(capture.modes, "utf8")).trim().split("\n"),
				).toEqual(["600", "600", "700"]);
				expect(await readdir(buildDirectory)).toEqual([]);
			} finally {
				await rm(testRoot, { force: true, recursive: true });
			}
		},
	);

	it("rejects credentialed clone URLs and invalid credential records", () => {
		const validOptions = {
			branch: "main",
			cloneUrl: "https://example.test/owner/repository.git",
			enableSubmodules: false,
			outputPath: "/tmp/repository",
			password: "fixture-password",
			username: "fixture-user",
		};

		expect(() =>
			getAuthenticatedGitCloneCommand({
				...validOptions,
				cloneUrl:
					"https://fixture-user:fixture-password@example.test/repository.git",
			}),
		).toThrow("credential-free HTTP(S)");
		expect(() =>
			getAuthenticatedGitCloneCommand({
				...validOptions,
				password: "fixture-password\nsecond-line",
			}),
		).toThrow("non-empty single-line value");
	});
});
