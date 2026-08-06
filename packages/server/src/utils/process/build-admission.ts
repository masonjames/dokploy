import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { findServerById } from "@dokploy/server/services/server";
import { quote } from "shell-quote";
import { Client, type ClientChannel } from "ssh2";

const READY_PREFIX = "__DOKPLOY_BUILD_ADMISSION_READY_";
const RELEASE_PREFIX = "__DOKPLOY_BUILD_ADMISSION_RELEASE_";
const OUTPUT_LIMIT = 8192;

const FORWARDED_GATE_ENVIRONMENT = [
	"DOKPLOY_PLATFORM_CAPACITY_GATE_PATH",
	"DOKPLOY_PLATFORM_CAPACITY_GATE_SHA256",
	"DOKPLOY_PLATFORM_CAPACITY_POLICY_PATH",
	"DOKPLOY_PLATFORM_CAPACITY_POLICY_SHA256",
	"DOKPLOY_BUILD_DF_ADAPTER_PATH",
	"DOKPLOY_BUILD_DF_ADAPTER_SHA256",
] as const;

export type BuildAdmissionMode = "disabled" | "required";

export interface BuildAdmissionConfig {
	mode: BuildAdmissionMode;
	gatePath: string;
	gateSha256: string;
	lockPath: string;
	tempRoot: string;
	hostRootMount: string;
	waitSeconds: number;
	readyTimeoutGraceSeconds: number;
	gateEnvironment: Record<string, string>;
}

export interface BuildAdmissionContext {
	prepareCommand: (command: string) => Promise<string>;
	signal: AbortSignal;
	assertLockHeld: () => void;
}

interface LockHolder {
	stdin: Writable;
	stdout: Readable;
	stderr: Readable;
	done: Promise<LockHolderResult>;
	writePrivateFile: (path: string, contents: string) => Promise<void>;
	terminate: () => void;
}

interface LockHolderResult {
	code: number | null;
	signal?: string | null;
}

interface AcquiredLock {
	context: BuildAdmissionContext;
	release: () => Promise<void>;
	lost: Promise<never>;
}

export class BuildAdmissionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BuildAdmissionError";
	}
}

const requireAbsolutePath = (name: string, value: string) => {
	if (
		!value.startsWith("/") ||
		value.includes("\0") ||
		/[\r\n]/.test(value) ||
		value.split("/").some((segment) => segment === "." || segment === "..")
	) {
		throw new BuildAdmissionError(
			`${name} must be an absolute normalized single-line path`,
		);
	}
	return value.replace(/\/+$/, "") || "/";
};

const requireSha256 = (name: string, value: string) => {
	if (!/^[a-f0-9]{64}$/.test(value)) {
		throw new BuildAdmissionError(`${name} must be a lowercase SHA-256 digest`);
	}
	return value;
};

const parseWaitSeconds = (value: string | undefined) => {
	const configured = value || "1800";
	if (!/^[0-9]+$/.test(configured)) {
		throw new BuildAdmissionError(
			"DOKPLOY_BUILD_LOCK_WAIT_SECONDS must be a whole number",
		);
	}
	const parsed = Number(configured);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 86400) {
		throw new BuildAdmissionError(
			"DOKPLOY_BUILD_LOCK_WAIT_SECONDS must be between 1 and 86400",
		);
	}
	return parsed;
};

export const resolveBuildAdmissionConfig = (
	environment: NodeJS.ProcessEnv = process.env,
): BuildAdmissionConfig => {
	const mode = environment.DOKPLOY_BUILD_ADMISSION_MODE || "disabled";
	if (mode !== "disabled" && mode !== "required") {
		throw new BuildAdmissionError(
			"DOKPLOY_BUILD_ADMISSION_MODE must be disabled or required",
		);
	}

	if (mode === "disabled") {
		return {
			mode,
			gatePath: "",
			gateSha256: "",
			lockPath: "",
			tempRoot: "",
			hostRootMount: "",
			waitSeconds: 0,
			readyTimeoutGraceSeconds: 0,
			gateEnvironment: {},
		};
	}

	const gatePath = requireAbsolutePath(
		"DOKPLOY_BUILD_CAPACITY_GATE_PATH",
		environment.DOKPLOY_BUILD_CAPACITY_GATE_PATH || "",
	);
	const gateSha256 = requireSha256(
		"DOKPLOY_BUILD_CAPACITY_GATE_SHA256",
		environment.DOKPLOY_BUILD_CAPACITY_GATE_SHA256 || "",
	);
	const lockPath = requireAbsolutePath(
		"DOKPLOY_BUILD_LOCK_PATH",
		environment.DOKPLOY_BUILD_LOCK_PATH ||
			"/etc/dokploy/build-admission/build.lock",
	);
	const tempRoot = requireAbsolutePath(
		"DOKPLOY_BUILD_TEMP_ROOT",
		environment.DOKPLOY_BUILD_TEMP_ROOT || "/etc/dokploy/build-admission/tmp",
	);
	const hostRootMount = requireAbsolutePath(
		"DOKPLOY_BUILD_HOST_ROOT_MOUNT",
		environment.DOKPLOY_BUILD_HOST_ROOT_MOUNT || "",
	);

	if (gatePath === lockPath || gatePath.startsWith(`${tempRoot}/`)) {
		throw new BuildAdmissionError(
			"The capacity gate must be outside the lock and temporary paths",
		);
	}
	if (
		lockPath.startsWith(`${tempRoot}/`) ||
		tempRoot.startsWith(`${lockPath}/`)
	) {
		throw new BuildAdmissionError(
			"The build lock and temporary root must not contain one another",
		);
	}
	if (hostRootMount === "/") {
		throw new BuildAdmissionError(
			"Local Dokploy requires a dedicated read-only host-root mount, not container /",
		);
	}

	const gateEnvironment: Record<string, string> = {};
	for (const name of FORWARDED_GATE_ENVIRONMENT) {
		const value = environment[name];
		if (value !== undefined) {
			gateEnvironment[name] = value;
		}
	}

	return {
		mode,
		gatePath,
		gateSha256,
		lockPath,
		tempRoot,
		hostRootMount,
		waitSeconds: parseWaitSeconds(environment.DOKPLOY_BUILD_LOCK_WAIT_SECONDS),
		readyTimeoutGraceSeconds: 30,
		gateEnvironment,
	};
};

const shellQuote = (value: string) => quote([value]);

const privateScriptLauncher = ({
	scriptPath,
	tempDirectory,
}: {
	scriptPath: string;
	tempDirectory: string;
}) => `
set -eu
export DOKPLOY_BUILD_TMPDIR=${shellQuote(tempDirectory)}
export TMPDIR=${shellQuote(tempDirectory)}
_dokploy_private_script=${shellQuote(scriptPath)}
_dokploy_private_cleanup() {
	_dokploy_status=$?
	trap - EXIT HUP INT TERM
	rm -f -- "$_dokploy_private_script"
	exit "$_dokploy_status"
}
trap '_dokploy_private_cleanup' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
/bin/sh "$_dokploy_private_script"
`;

const wrapOwnedCommand = ({
	scriptPath,
	commandLockPath,
	ownerTokenPath,
	ownerNonce,
	tempDirectory,
	waitSeconds,
}: {
	scriptPath: string;
	commandLockPath: string;
	ownerTokenPath: string;
	ownerNonce: string;
	tempDirectory: string;
	waitSeconds: number;
}) => {
	const commandNonce = randomUUID().replaceAll("-", "");
	const readyPath = join(tempDirectory, `owned-${commandNonce}.ready`);

	return `
set -eu
export DOKPLOY_BUILD_TMPDIR=${shellQuote(tempDirectory)}
export TMPDIR=${shellQuote(tempDirectory)}
_dokploy_owned_script=${shellQuote(scriptPath)}
_dokploy_command_lock=${shellQuote(commandLockPath)}
_dokploy_owner_token=${shellQuote(ownerTokenPath)}
_dokploy_owner_nonce=${shellQuote(ownerNonce)}
_dokploy_owned_ready=${shellQuote(readyPath)}
_dokploy_owned_pid=""
_dokploy_monitor_pid=""
_dokploy_token_matches() {
	[ -r "$_dokploy_owner_token" ] &&
		[ "$(cat "$_dokploy_owner_token" 2>/dev/null)" = "$_dokploy_owner_nonce" ]
}
_dokploy_kill_owned() {
	[ -n "$_dokploy_owned_pid" ] || return 0
	if /bin/kill -0 -- "-$_dokploy_owned_pid" 2>/dev/null; then
		/bin/kill -TERM -- "-$_dokploy_owned_pid" 2>/dev/null || true
		_dokploy_attempt=0
		while /bin/kill -0 -- "-$_dokploy_owned_pid" 2>/dev/null; do
			_dokploy_attempt=$((_dokploy_attempt + 1))
			if [ "$_dokploy_attempt" -ge 50 ]; then
				/bin/kill -KILL -- "-$_dokploy_owned_pid" 2>/dev/null || true
			fi
			sleep 0.1
		done
	elif /bin/kill -0 "$_dokploy_owned_pid" 2>/dev/null; then
		/bin/kill -TERM "$_dokploy_owned_pid" 2>/dev/null || true
	fi
}
_dokploy_stop_monitor() {
	if [ -n "$_dokploy_monitor_pid" ]; then
		/bin/kill -TERM "$_dokploy_monitor_pid" 2>/dev/null || true
		wait "$_dokploy_monitor_pid" 2>/dev/null || true
	fi
}
_dokploy_owned_cleanup() {
	_dokploy_status=$?
	trap - EXIT HUP INT TERM
	_dokploy_stop_monitor
	_dokploy_kill_owned
	rm -f -- "$_dokploy_owned_ready" "$_dokploy_owned_script"
	exit "$_dokploy_status"
}
trap '_dokploy_owned_cleanup' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

exec 8>"$_dokploy_command_lock"
if ! flock --shared --wait ${waitSeconds} 8; then
	echo "DENY command ownership lock wait timed out" >&2
	exit 78
fi
_dokploy_token_matches || {
	echo "DENY build admission ownership changed before command start" >&2
	exit 78
}

rm -f -- "$_dokploy_owned_ready"
python3 -c 'import os, stat, sys; path = sys.argv[1]; fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)); info = os.fstat(fd); valid = stat.S_ISREG(info.st_mode) and not (info.st_mode & 0o077) and info.st_uid == os.geteuid();
if not valid: os.close(fd); raise SystemExit("private command file permissions are invalid")
os.set_inheritable(fd, True); os.setsid(); open(sys.argv[2], "x").close(); fd_path = f"/proc/self/fd/{fd}" if os.path.exists("/proc/self/fd") else f"/dev/fd/{fd}"; os.execv("/bin/sh", ["/bin/sh", fd_path])' "$_dokploy_owned_script" "$_dokploy_owned_ready" &
_dokploy_owned_pid=$!
while [ ! -e "$_dokploy_owned_ready" ]; do
	if ! /bin/kill -0 "$_dokploy_owned_pid" 2>/dev/null; then
		set +e
		wait "$_dokploy_owned_pid"
		_dokploy_status=$?
		set -e
		exit "$_dokploy_status"
	fi
	_dokploy_token_matches || {
		_dokploy_kill_owned
		exit 78
	}
	sleep 0.05
done
(
	while _dokploy_token_matches; do
		sleep 0.1
	done
	_dokploy_kill_owned
) &
_dokploy_monitor_pid=$!
set +e
wait "$_dokploy_owned_pid"
_dokploy_status=$?
set -e
_dokploy_stop_monitor
_dokploy_monitor_pid=""
rm -f -- "$_dokploy_owned_ready" "$_dokploy_owned_script"
trap - EXIT HUP INT TERM
exit "$_dokploy_status"
`;
};

const buildLockHolderCommand = ({
	config,
	nonce,
	remote,
}: {
	config: BuildAdmissionConfig;
	nonce: string;
	remote: boolean;
}) => {
	const readyMarker = `${READY_PREFIX}${nonce}__`;
	const releaseMarker = `${RELEASE_PREFIX}${nonce}__`;
	const tempDirectory = join(config.tempRoot, `build-${nonce}`);
	const ownerTokenPath = `${config.lockPath}.owner`;
	const commandLockPath = `${config.lockPath}.commands`;
	const namespaceMode = remote ? "host" : "container";
	const hostRootMount = remote ? "/" : config.hostRootMount;
	const exports = Object.entries({
		...config.gateEnvironment,
		DOKPLOY_BUILD_GATE_NAMESPACE_MODE: namespaceMode,
		DOKPLOY_BUILD_HOST_ROOT_MOUNT: hostRootMount,
	})
		.map(([name, value]) => `export ${name}=${shellQuote(value)}`)
		.join("\n");

	return {
		readyMarker,
		releaseMarker,
		tempDirectory,
		ownerTokenPath,
		commandLockPath,
		command: `
set -eu
umask 077
${exports}
_dokploy_gate=${shellQuote(config.gatePath)}
_dokploy_gate_sha=${shellQuote(config.gateSha256)}
_dokploy_lock=${shellQuote(config.lockPath)}
_dokploy_owner_token=${shellQuote(ownerTokenPath)}
_dokploy_owner_nonce=${shellQuote(nonce)}
_dokploy_command_lock=${shellQuote(commandLockPath)}
_dokploy_temp_root=${shellQuote(config.tempRoot)}
_dokploy_temp=${shellQuote(tempDirectory)}
_dokploy_ready=${shellQuote(readyMarker)}
_dokploy_release_expected=${shellQuote(releaseMarker)}

for _dokploy_dependency in awk cat flock python3 rm sleep; do
	command -v "$_dokploy_dependency" >/dev/null 2>&1 || {
		echo "DENY build admission dependency is unavailable: $_dokploy_dependency" >&2
		exit 70
	}
done
[ -x /bin/kill ] || {
	echo "DENY build admission dependency is unavailable: /bin/kill" >&2
	exit 70
}
_dokploy_sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum -- "$1" | awk '{ print $1 }'
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 -- "$1" | awk '{ print $1 }'
	else
		echo "DENY build admission dependency is unavailable: sha256sum or shasum" >&2
		return 70
	fi
}
[ -x "$_dokploy_gate" ] || {
	echo "DENY build capacity gate is not executable" >&2
	exit 71
}
[ -d "$_dokploy_temp_root" ] && [ -w "$_dokploy_temp_root" ] || {
	echo "DENY build temporary root is unavailable" >&2
	exit 71
}
[ -d "$(dirname "$_dokploy_lock")" ] && [ -w "$(dirname "$_dokploy_lock")" ] || {
	echo "DENY build lock directory is unavailable" >&2
	exit 71
}

exec 9>"$_dokploy_lock"
if ! flock --exclusive --wait ${config.waitSeconds} 9; then
	echo "DENY host build lock wait timed out" >&2
	exit 72
fi

_dokploy_previous_owner=""
if [ -e "$_dokploy_owner_token" ]; then
	[ -r "$_dokploy_owner_token" ] || {
		echo "DENY previous build owner token is unreadable" >&2
		exit 71
	}
	_dokploy_previous_owner=$(cat "$_dokploy_owner_token")
	[ "\${#_dokploy_previous_owner}" -eq 32 ] || {
		echo "DENY previous build owner token has invalid length" >&2
		exit 71
	}
	case "$_dokploy_previous_owner" in
		*[!0-9a-f]*)
			echo "DENY previous build owner token is invalid" >&2
			exit 71
			;;
	esac
fi

_dokploy_cleanup() {
	_dokploy_status=$?
	trap - EXIT HUP INT TERM
	if [ -e "$_dokploy_temp" ]; then
		case "$_dokploy_temp" in
			"$_dokploy_temp_root"/build-*)
				if ! rm -rf -- "$_dokploy_temp"; then
					echo "DENY build temporary cleanup failed" >&2
					_dokploy_status=76
				fi
				;;
			*)
				echo "DENY build temporary cleanup target is invalid" >&2
				_dokploy_status=76
				;;
		esac
	fi
	if [ -r "$_dokploy_owner_token" ] &&
		[ "$(cat "$_dokploy_owner_token" 2>/dev/null)" = "$_dokploy_owner_nonce" ]; then
		if ! rm -f -- "$_dokploy_owner_token"; then
			echo "DENY build owner-token cleanup failed" >&2
			_dokploy_status=76
		fi
	else
		echo "DENY build owner token changed unexpectedly" >&2
		_dokploy_status=76
	fi
	if ! flock --unlock 9; then
		echo "DENY host build lock release failed" >&2
		_dokploy_status=76
	fi
	exit "$_dokploy_status"
}
trap '_dokploy_cleanup' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

printf '%s\n' "$_dokploy_owner_nonce" > "$_dokploy_owner_token"
exec 8>"$_dokploy_command_lock"
if ! flock --exclusive --wait ${config.waitSeconds} 8; then
	echo "DENY prior owned command drain timed out" >&2
	exit 72
fi
if ! flock --unlock 8; then
	echo "DENY command ownership lock release failed" >&2
	exit 76
fi

if [ -n "$_dokploy_previous_owner" ] &&
	[ "$_dokploy_previous_owner" != "$_dokploy_owner_nonce" ]; then
	_dokploy_previous_temp="$_dokploy_temp_root/build-$_dokploy_previous_owner"
	case "$_dokploy_previous_temp" in
		"$_dokploy_temp_root"/build-*)
			if [ -e "$_dokploy_previous_temp" ] &&
				! rm -rf -- "$_dokploy_previous_temp"; then
				echo "DENY stale build temporary cleanup failed" >&2
				exit 76
			fi
			;;
		*)
			echo "DENY stale build temporary target is invalid" >&2
			exit 76
			;;
	esac
fi

_dokploy_gate_actual_sha=$(_dokploy_sha256 "$_dokploy_gate") || exit $?
[ "$_dokploy_gate_actual_sha" = "$_dokploy_gate_sha" ] || {
	echo "DENY build capacity gate checksum mismatch" >&2
	exit 73
}

if ! _dokploy_gate_output=$("$_dokploy_gate" 2>&1); then
	printf '%s\n' "$_dokploy_gate_output" >&2
	echo "DENY build capacity gate failed" >&2
	exit 74
fi
printf '%s\n' "$_dokploy_gate_output"
_dokploy_allowed_count=$(printf '%s\n' "$_dokploy_gate_output" | awk '$0 == "DOKPLOY_BUILD_ADMISSION=allowed" { count++ } END { print count + 0 }')
_dokploy_namespace_count=$(printf '%s\n' "$_dokploy_gate_output" | awk '$0 == "DOKPLOY_BUILD_GATE_NAMESPACE=host" { count++ } END { print count + 0 }')
[ "$_dokploy_allowed_count" -eq 1 ] && [ "$_dokploy_namespace_count" -eq 1 ] || {
	echo "DENY build capacity gate attestation is incomplete" >&2
	exit 75
}

mkdir -- "$_dokploy_temp"

printf '%s\n' "$_dokploy_ready"
IFS= read -r _dokploy_release
[ "$_dokploy_release" = "$_dokploy_release_expected" ] || {
	echo "DENY host build lock release token is invalid" >&2
	exit 77
}
exit 0
`,
	};
};

const startLocalHolder = (command: string): LockHolder => {
	const child = spawn("/bin/sh", ["-c", command], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	return {
		stdin: child.stdin,
		stdout: child.stdout,
		stderr: child.stderr,
		done: new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => resolve({ code, signal }));
		}),
		writePrivateFile: async (path, contents) => {
			await writeFile(path, contents, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
		},
		terminate: () => child.kill("SIGTERM"),
	};
};

const execRemoteControlCommand = async (
	connection: Client,
	command: string,
	input?: string,
) =>
	await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		connection.exec(command, (error, channel) => {
			if (error) {
				reject(error);
				return;
			}
			let stdout = "";
			let stderr = "";
			let settled = false;
			const fail = (failure: unknown) => {
				if (settled) return;
				settled = true;
				reject(failure);
			};
			channel.on("data", (chunk: Buffer | string) => {
				stdout += chunk.toString();
			});
			channel.stderr.on("data", (chunk: Buffer | string) => {
				stderr += chunk.toString();
			});
			channel.once("error", fail);
			channel.once("close", (code: number | null) => {
				if (settled) return;
				settled = true;
				if (code === 0) {
					resolve({ stdout, stderr });
				} else {
					reject(
						new BuildAdmissionError(
							`Remote private transport command failed (code=${code ?? "null"})${stderr ? `: ${boundedOutput(stderr)}` : ""}`,
						),
					);
				}
			});
			channel.end(input);
		});
	});

const connectRemoteClient = async (serverId: string) => {
	const server = await findServerById(serverId);
	const privateKey = server.sshKey?.privateKey;
	if (!server.sshKeyId || !privateKey) {
		throw new BuildAdmissionError(
			"Remote private transport requires an SSH key",
		);
	}

	const connection = new Client();
	await new Promise<void>((resolve, reject) => {
		connection.once("ready", resolve).once("error", reject).connect({
			host: server.ipAddress,
			port: server.port,
			username: server.username,
			privateKey,
			timeout: 99999,
		});
	});
	return connection;
};

const startRemoteHolder = async (
	serverId: string,
	command: string,
): Promise<LockHolder> => {
	const connection = await connectRemoteClient(serverId);
	const stream = await new Promise<ClientChannel>((resolve, reject) => {
		connection.exec(command, (error, channel) => {
			if (error) {
				connection.end();
				reject(error);
				return;
			}
			resolve(channel);
		});
	});

	return {
		stdin: stream,
		stdout: stream,
		stderr: stream.stderr,
		done: new Promise((resolve) => {
			stream.once("close", (code: number | null, signal: string | null) => {
				connection.end();
				resolve({ code, signal });
			});
		}),
		writePrivateFile: async (path, contents) => {
			await execRemoteControlCommand(
				connection,
				`umask 077; set -C; cat > ${shellQuote(path)}`,
				contents,
			);
		},
		terminate: () => {
			stream.close();
			connection.end();
		},
	};
};

const boundedOutput = (value: string) => {
	const trimmed = value.trim();
	if (trimmed.length <= OUTPUT_LIMIT) return trimmed;
	return `${trimmed.slice(0, OUTPUT_LIMIT)}\n[output truncated]`;
};

const createDisabledPrivateTransport = async (serverId: string | null) => {
	let connection: Client | undefined;
	let tempDirectory: string;
	if (serverId) {
		connection = await connectRemoteClient(serverId);
		try {
			const { stdout } = await execRemoteControlCommand(
				connection,
				"umask 077; mktemp -d /tmp/dokploy-command.XXXXXXXX",
			);
			tempDirectory = stdout.trim();
			if (!/^\/tmp\/dokploy-command\.[A-Za-z0-9]{8}$/.test(tempDirectory)) {
				throw new BuildAdmissionError(
					"Remote private transport returned an invalid temporary path",
				);
			}
		} catch (error) {
			connection.end();
			throw error;
		}
	} else {
		tempDirectory = await mkdtemp(join(tmpdir(), "dokploy-command."));
		await chmod(tempDirectory, 0o700);
	}

	const signal = new AbortController().signal;
	const context: BuildAdmissionContext = {
		prepareCommand: async (command) => {
			const nonce = randomUUID().replaceAll("-", "");
			const scriptPath = join(tempDirectory, `command-${nonce}.sh`);
			if (connection) {
				await execRemoteControlCommand(
					connection,
					`umask 077; set -C; cat > ${shellQuote(scriptPath)}`,
					command,
				);
			} else {
				await writeFile(scriptPath, command, {
					encoding: "utf8",
					flag: "wx",
					mode: 0o600,
				});
			}
			return privateScriptLauncher({ scriptPath, tempDirectory });
		},
		signal,
		assertLockHeld: () => undefined,
	};

	return {
		context,
		cleanup: async () => {
			if (connection) {
				try {
					await execRemoteControlCommand(
						connection,
						`rm -rf -- ${shellQuote(tempDirectory)}`,
					);
				} finally {
					connection.end();
				}
			} else {
				await rm(tempDirectory, { recursive: true, force: true });
			}
		},
	};
};

const waitUntilReady = async (
	holder: LockHolder,
	readyMarker: string,
	waitSeconds: number,
	readyTimeoutGraceSeconds: number,
) => {
	let stdout = "";
	let stderr = "";
	let ready = false;

	holder.stdout.on("data", (chunk: Buffer | string) => {
		stdout += chunk.toString();
	});
	holder.stderr.on("data", (chunk: Buffer | string) => {
		stderr += chunk.toString();
	});

	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => {
				holder.terminate();
				reject(
					new BuildAdmissionError("Timed out acquiring the host build lock"),
				);
			},
			(waitSeconds + readyTimeoutGraceSeconds) * 1000,
		);
		timer.unref();
	});

	const acquired = new Promise<string>((resolve, reject) => {
		const inspect = () => {
			const markerIndex = stdout.indexOf(`${readyMarker}\n`);
			if (markerIndex >= 0) {
				ready = true;
				resolve(stdout.slice(0, markerIndex));
			}
		};
		holder.stdout.on("data", inspect);
		inspect();
		holder.done.then(
			({ code, signal }) => {
				if (!ready) {
					reject(
						new BuildAdmissionError(
							`Build admission failed before lock acquisition (code=${code ?? "null"}, signal=${signal || "none"})${stderr ? `: ${boundedOutput(stderr)}` : ""}`,
						),
					);
				}
			},
			(error) => reject(error),
		);
	});

	try {
		return await Promise.race([acquired, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
};

const acquireBuildLock = async ({
	config,
	serverId,
}: {
	config: BuildAdmissionConfig;
	serverId: string | null;
}): Promise<AcquiredLock> => {
	const nonce = randomUUID().replaceAll("-", "");
	const {
		command,
		readyMarker,
		releaseMarker,
		tempDirectory,
		ownerTokenPath,
		commandLockPath,
	} = buildLockHolderCommand({
		config,
		nonce,
		remote: !!serverId,
	});
	const holder = serverId
		? await startRemoteHolder(serverId, command)
		: startLocalHolder(command);
	const evidence = boundedOutput(
		await waitUntilReady(
			holder,
			readyMarker,
			config.waitSeconds,
			config.readyTimeoutGraceSeconds,
		),
	);
	if (evidence) console.info(`[build-admission]\n${evidence}`);

	const abortController = new AbortController();
	let releaseRequested = false;
	const lost = holder.done.then(({ code, signal }) => {
		if (!releaseRequested) {
			const error = new BuildAdmissionError(
				`Host build lock was lost (code=${code ?? "null"}, signal=${signal || "none"})`,
			);
			abortController.abort(error);
			throw error;
		}
		return new Promise<never>(() => undefined);
	});

	return {
		context: {
			prepareCommand: async (commandToPrepare: string) => {
				if (abortController.signal.aborted) {
					throw (
						abortController.signal.reason ||
						new BuildAdmissionError("Host build lock was lost")
					);
				}
				const commandNonce = randomUUID().replaceAll("-", "");
				const scriptPath = join(tempDirectory, `command-${commandNonce}.sh`);
				await holder.writePrivateFile(scriptPath, commandToPrepare);
				if (abortController.signal.aborted) {
					throw (
						abortController.signal.reason ||
						new BuildAdmissionError("Host build lock was lost")
					);
				}
				return wrapOwnedCommand({
					scriptPath,
					commandLockPath,
					ownerTokenPath,
					ownerNonce: nonce,
					tempDirectory,
					waitSeconds: config.waitSeconds,
				});
			},
			signal: abortController.signal,
			assertLockHeld: () => {
				if (abortController.signal.aborted) {
					throw (
						abortController.signal.reason ||
						new BuildAdmissionError("Host build lock was lost")
					);
				}
			},
		},
		lost,
		release: async () => {
			releaseRequested = true;
			let writeFailed = false;
			if (
				holder.stdin.destroyed ||
				holder.stdin.writableEnded ||
				!holder.stdin.writable
			) {
				writeFailed = true;
			} else {
				try {
					await new Promise<void>((resolve, reject) => {
						const onError = (error: Error) => {
							holder.stdin.off("error", onError);
							reject(error);
						};
						holder.stdin.once("error", onError);
						holder.stdin.end(`${releaseMarker}\n`, () => {
							holder.stdin.off("error", onError);
							resolve();
						});
					});
				} catch {
					writeFailed = true;
				}
			}
			const { code, signal } = await holder.done;
			if (writeFailed || code !== 0) {
				throw new BuildAdmissionError(
					`Host build lock cleanup failed (release=${writeFailed ? "failed" : "sent"}, code=${code ?? "null"}, signal=${signal || "none"})`,
				);
			}
		},
	};
};

export const withHostBuildAdmission = async <Result>(
	options: {
		serverId: string | null;
		operation: string;
		config?: BuildAdmissionConfig;
		environment?: NodeJS.ProcessEnv;
	},
	callback: (context: BuildAdmissionContext) => Promise<Result>,
): Promise<Result> => {
	const environment = options.environment || process.env;
	const config = options.config || resolveBuildAdmissionConfig(environment);
	if (config.mode === "disabled") {
		const transport = await createDisabledPrivateTransport(options.serverId);
		let callbackFailed = false;
		let callbackError: unknown;
		let result: Result | undefined;
		try {
			result = await callback(transport.context);
		} catch (error) {
			callbackFailed = true;
			callbackError = error;
		}
		try {
			await transport.cleanup();
		} catch (cleanupError) {
			if (!callbackFailed) throw cleanupError;
			console.error(
				`Private command transport cleanup also failed for ${options.operation}`,
				cleanupError,
			);
		}
		if (callbackFailed) throw callbackError;
		return result as Result;
	}
	if (
		!options.serverId &&
		(environment.DOKPLOY_DOCKER_HOST ||
			environment.DOKPLOY_DOCKER_PORT ||
			environment.DOCKER_HOST ||
			environment.DOCKER_CONTEXT)
	) {
		throw new BuildAdmissionError(
			"Required local build admission cannot verify a custom Docker endpoint environment",
		);
	}

	const acquired = await acquireBuildLock({
		config,
		serverId: options.serverId,
	});
	let result: Result | undefined;
	let callbackFailed = false;
	let callbackError: unknown;
	let callbackPromise: Promise<Result> | undefined;
	try {
		callbackPromise = callback(acquired.context);
		result = await Promise.race([callbackPromise, acquired.lost]);
	} catch (error) {
		callbackFailed = true;
		callbackError = error;
		if (acquired.context.signal.aborted && callbackPromise) {
			try {
				await callbackPromise;
			} catch (cleanupError) {
				if (cleanupError !== error) {
					console.error(
						`Admitted operation cleanup also failed for ${options.operation}`,
						cleanupError,
					);
				}
			}
		}
	}

	let releaseFailed = false;
	let releaseError: unknown;
	try {
		await acquired.release();
	} catch (error) {
		releaseFailed = true;
		releaseError = error;
	}

	if (callbackFailed) {
		if (releaseFailed) {
			console.error(
				`Build admission cleanup also failed for ${options.operation}`,
				releaseError,
			);
		}
		throw callbackError;
	}
	if (releaseFailed) throw releaseError;
	return result as Result;
};
