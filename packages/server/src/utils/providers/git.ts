import path, { join } from "node:path";
import { paths } from "@dokploy/server/constants";
import {
	findSSHKeyById,
	updateSSHKeyById,
} from "@dokploy/server/services/ssh-key";
import { quote } from "shell-quote";
import { execAsync, execAsyncRemote } from "../process/execAsync";

interface CloneGitRepository {
	appName: string;
	customGitUrl?: string | null;
	customGitBranch?: string | null;
	customGitSSHKeyId?: string | null;
	enableSubmodules?: boolean;
	serverId: string | null;
	type?: "application" | "compose";
	outputPathOverride?: string;
}

export const cloneGitRepository = async ({
	type = "application",
	...entity
}: CloneGitRepository) => {
	let command = "set -e;";
	const {
		appName,
		customGitUrl,
		customGitBranch,
		customGitSSHKeyId,
		enableSubmodules,
		serverId,
		outputPathOverride,
	} = entity;
	const { SSH_PATH, COMPOSE_PATH, APPLICATIONS_PATH } = paths(!!serverId);

	if (!customGitUrl || !customGitBranch) {
		command += `echo "Error: ❌ Repository not found"; exit 1;`;
		return command;
	}
	const safeCustomGitUrl = isHttpOrHttps(customGitUrl)
		? requireCredentialFreeHttpUrl(customGitUrl)
		: customGitUrl;

	command += `: "\${DOKPLOY_BUILD_TMPDIR:?DOKPLOY_BUILD_TMPDIR is required for custom git clones}";`;
	const temporalKeyPath = "${DOKPLOY_BUILD_TMPDIR}/id_rsa";
	const quotedTemporalKeyPath = `"${temporalKeyPath}"`;

	const basePath = type === "compose" ? COMPOSE_PATH : APPLICATIONS_PATH;
	const outputPath = outputPathOverride ?? join(basePath, appName, "code");
	const knownHostsPath = path.join(SSH_PATH, "known_hosts");

	if (!isHttpOrHttps(safeCustomGitUrl)) {
		if (!customGitSSHKeyId) {
			command += `echo "Error: ❌ You are trying to clone a ssh repository without a ssh key, please set a ssh key"; exit 1;`;
			return command;
		}
		command += addHostToKnownHostsCommand(safeCustomGitUrl);
	}
	command += `rm -rf ${outputPath};`;
	command += `mkdir -p ${outputPath};`;
	command += `printf '%s\\n' ${quote([`Cloning Repo Custom ${safeCustomGitUrl} to ${outputPath}: ✅`])};`;

	if (customGitSSHKeyId) {
		await updateSSHKeyById({
			sshKeyId: customGitSSHKeyId,
			lastUsedAt: new Date().toISOString(),
		});
	}

	if (customGitSSHKeyId) {
		const sshKey = await findSSHKeyById(customGitSSHKeyId);
		const { port } = sanitizeRepoPathSSH(safeCustomGitUrl);
		const gitSshCommand = `ssh -i \\"${temporalKeyPath}\\"${port ? ` -p ${port}` : ""} -o UserKnownHostsFile=${knownHostsPath} -o StrictHostKeyChecking=accept-new`;
		command += `printf '%s' ${quote([sshKey.privateKey])} > ${quotedTemporalKeyPath};`;
		command += `chmod 600 ${quotedTemporalKeyPath};`;
		command += `export GIT_SSH_COMMAND="${gitSshCommand}";`;
	}
	command += `if ! git clone --branch ${quote([customGitBranch])} --depth 1 ${enableSubmodules ? "--recurse-submodules" : ""} --progress -- ${quote([safeCustomGitUrl])} ${quote([outputPath])}; then
				printf '%s\\n' ${quote([`❌ [ERROR] Fail to clone the repository ${safeCustomGitUrl}`])};
				exit 1;
			fi
			`;

	return command;
};

const isHttpOrHttps = (url: string): boolean => {
	const regex = /^https?:\/\//;
	return regex.test(url);
};

const requireCredentialFreeHttpUrl = (value: string) => {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("Custom Git URL must be an absolute HTTP(S) URL");
	}
	if (
		(parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
		parsed.username ||
		parsed.password
	) {
		throw new Error(
			"Custom Git HTTP(S) URLs must not contain credentials; use SSH or a configured provider",
		);
	}
	return parsed.toString();
};

// const addHostToKnownHosts = async (repositoryURL: string) => {
// 	const { SSH_PATH } = paths();
// 	const { domain, port } = sanitizeRepoPathSSH(repositoryURL);
// 	const knownHostsPath = path.join(SSH_PATH, "known_hosts");

// 	const command = `ssh-keyscan -p ${port} ${domain} >> ${knownHostsPath}`;
// 	try {
// 		await execAsync(command);
// 	} catch (error) {
// 		console.error(`Error adding host to known_hosts: ${error}`);
// 		throw error;
// 	}
// };

const addHostToKnownHostsCommand = (repositoryURL: string) => {
	const { SSH_PATH } = paths(true);
	const { domain, port } = sanitizeRepoPathSSH(repositoryURL);
	const knownHostsPath = path.join(SSH_PATH, "known_hosts");

	// ssh-keyscan is best-effort: some Git hosts (e.g. Hugging Face) never answer
	// it, and its exit code must not abort the clone under `set -e`. The clone's
	// own host-key check (StrictHostKeyChecking=accept-new) is the real boundary.
	return `ssh-keyscan -p ${quote([String(port)])} ${quote([domain])} >> ${quote([knownHostsPath])} || true;`;
};
const sanitizeRepoPathSSH = (input: string) => {
	const SSH_PATH_RE = new RegExp(
		[
			/^\s*/,
			/(?:(?<proto>[a-z]+):\/\/)?/,
			/(?:(?<user>[a-z_][a-z0-9_-]+)@)?/,
			/(?<domain>[^\s/?#:]+)/,
			/(?::(?<port>[0-9]{1,5}))?/,
			/(?:[/:](?<owner>[^\s/?#:]+))?/,
			/(?:[/:](?<repo>(?:[^\s?#:.]|\.(?!git\/?\s*$))+))/,
			/(?:.git)?\/?\s*$/,
		]
			.map((r) => r.source)
			.join(""),
		"i",
	);

	const found = input.match(SSH_PATH_RE);
	if (!found) {
		throw new Error(`Malformatted SSH path: ${input}`);
	}
	const domain = found.groups?.domain;
	const port = Number(found.groups?.port ?? 22);
	if (!domain || !/^[a-z0-9._-]+$/i.test(domain)) {
		throw new Error(`Malformatted SSH host: ${input}`);
	}
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`Invalid SSH port: ${input}`);
	}

	return {
		user: found.groups?.user ?? "git",
		domain,
		port,
		owner: found.groups?.owner ?? "",
		repo: found.groups?.repo,
		get repoPath() {
			return `ssh://${this.user}@${this.domain}:${this.port}/${this.owner}${
				this.owner && "/"
			}${this.repo}.git`;
		},
	};
};

interface Props {
	appName: string;
	type?: "application" | "compose";
	serverId: string | null;
}

export const getGitCommitInfo = async ({
	appName,
	type = "application",
	serverId,
}: Props) => {
	const { COMPOSE_PATH, APPLICATIONS_PATH } = paths(!!serverId);
	const basePath = type === "compose" ? COMPOSE_PATH : APPLICATIONS_PATH;
	const outputPath = join(basePath, appName, "code");
	let stdoutResult = "";
	const result = {
		message: "",
		hash: "",
	};
	try {
		const gitCommand = `git -C ${outputPath} log -1 --pretty=format:"%H---DELIMITER---%B"`;
		if (serverId) {
			const { stdout } = await execAsyncRemote(serverId, gitCommand);
			stdoutResult = stdout.trim();
		} else {
			const { stdout } = await execAsync(gitCommand);
			stdoutResult = stdout.trim();
		}

		const parts = stdoutResult.split("---DELIMITER---");
		if (parts && parts.length === 2) {
			result.hash = parts[0]?.trim() || "";
			result.message = parts[1]?.trim() || "";
		}
	} catch (error) {
		console.error(`Error getting git commit info: ${error}`);
		return null;
	}
	return result;
};
