import { randomUUID } from "node:crypto";
import { quote } from "shell-quote";

interface AuthenticatedGitCloneOptions {
	branch: string;
	cloneUrl: string;
	enableSubmodules: boolean;
	outputPath: string;
	password: string | null | undefined;
	username: string | null | undefined;
}

const shellQuote = (value: string) => quote([value]);

const requireSingleLineCredential = (
	name: string,
	value: string | null | undefined,
) => {
	if (
		typeof value !== "string" ||
		!value ||
		value.includes("\0") ||
		/[\r\n]/.test(value)
	) {
		throw new Error(`${name} must be a non-empty single-line value`);
	}
	return value;
};

const requireCredentialFreeHttpUrl = (value: string) => {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("Git clone URL must be an absolute HTTP(S) URL");
	}
	if (
		(parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
		parsed.username ||
		parsed.password
	) {
		throw new Error("Git clone URL must be credential-free HTTP(S)");
	}
	return {
		host: parsed.host,
		protocol: parsed.protocol.slice(0, -1),
		url: parsed.toString(),
	};
};

/**
 * Render an authenticated clone without placing either credential in git argv.
 * The containing deployment command is staged as a private file by build
 * admission; this fragment creates short-lived credential files plus a
 * secret-free executable askpass helper beneath that same private directory.
 */
export const getAuthenticatedGitCloneCommand = ({
	branch,
	cloneUrl,
	enableSubmodules,
	outputPath,
	password,
	username,
}: AuthenticatedGitCloneOptions) => {
	const {
		host: expectedHost,
		protocol: expectedProtocol,
		url: safeCloneUrl,
	} = requireCredentialFreeHttpUrl(cloneUrl);
	const safeUsername = requireSingleLineCredential("Git username", username);
	const safePassword = requireSingleLineCredential("Git credential", password);
	const nonce = randomUUID().replaceAll("-", "");
	const recurseSubmodules = enableSubmodules ? "--recurse-submodules" : "";

	return `
: "\${DOKPLOY_BUILD_TMPDIR:?DOKPLOY_BUILD_TMPDIR is required for authenticated git clones}"
_dokploy_git_temp_root="$DOKPLOY_BUILD_TMPDIR"
_dokploy_git_username_file="$_dokploy_git_temp_root/git-username-${nonce}"
_dokploy_git_password_file="$_dokploy_git_temp_root/git-password-${nonce}"
_dokploy_git_credential_helper="$_dokploy_git_temp_root/git-credential-${nonce}"
_dokploy_git_cleanup() {
	rm -f -- "$_dokploy_git_username_file" "$_dokploy_git_password_file" "$_dokploy_git_credential_helper" || true
}
trap '_dokploy_git_cleanup' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
_dokploy_git_old_umask=$(umask)
umask 077
printf '%s' ${shellQuote(safeUsername)} > "$_dokploy_git_username_file"
printf '%s' ${shellQuote(safePassword)} > "$_dokploy_git_password_file"
cat > "$_dokploy_git_credential_helper" <<-'DOKPLOY_GIT_CREDENTIAL_EOF'
#!/bin/sh
set -eu
_dokploy_git_operation=\${1:-}
[ "$_dokploy_git_operation" = "get" ] || exit 0
_dokploy_git_protocol=""
_dokploy_git_host=""
while IFS= read -r _dokploy_git_line; do
	[ -n "$_dokploy_git_line" ] || break
	case "$_dokploy_git_line" in
		protocol=*) _dokploy_git_protocol=\${_dokploy_git_line#protocol=} ;;
		host=*) _dokploy_git_host=\${_dokploy_git_line#host=} ;;
	esac
done
[ "$_dokploy_git_protocol" = "$DOKPLOY_GIT_EXPECTED_PROTOCOL" ] || exit 0
[ "$_dokploy_git_host" = "$DOKPLOY_GIT_EXPECTED_HOST" ] || exit 0
printf 'username=%s\n' "$(cat "$DOKPLOY_GIT_USERNAME_FILE")"
printf 'password=%s\n' "$(cat "$DOKPLOY_GIT_PASSWORD_FILE")"
DOKPLOY_GIT_CREDENTIAL_EOF
chmod 0600 "$_dokploy_git_username_file" "$_dokploy_git_password_file"
chmod 0700 "$_dokploy_git_credential_helper"
umask "$_dokploy_git_old_umask"
export DOKPLOY_GIT_USERNAME_FILE="$_dokploy_git_username_file"
export DOKPLOY_GIT_PASSWORD_FILE="$_dokploy_git_password_file"
export DOKPLOY_GIT_EXPECTED_PROTOCOL=${shellQuote(expectedProtocol)}
export DOKPLOY_GIT_EXPECTED_HOST=${shellQuote(expectedHost)}
export GIT_CONFIG_COUNT=3
export GIT_CONFIG_KEY_0=credential.helper
export GIT_CONFIG_VALUE_0=
export GIT_CONFIG_KEY_1=credential.helper
export GIT_CONFIG_VALUE_1="!$_dokploy_git_credential_helper"
export GIT_CONFIG_KEY_2=credential.useHttpPath
export GIT_CONFIG_VALUE_2=false
export GIT_ASKPASS=/bin/false
export GIT_ASKPASS_REQUIRE=force
export GIT_TERMINAL_PROMPT=0
git clone --branch ${shellQuote(branch)} --depth 1 ${recurseSubmodules} --progress -- ${shellQuote(safeCloneUrl)} ${shellQuote(outputPath)}
_dokploy_git_cleanup
trap - EXIT HUP INT TERM
unset DOKPLOY_GIT_USERNAME_FILE DOKPLOY_GIT_PASSWORD_FILE DOKPLOY_GIT_EXPECTED_PROTOCOL DOKPLOY_GIT_EXPECTED_HOST GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 GIT_CONFIG_KEY_1 GIT_CONFIG_VALUE_1 GIT_CONFIG_KEY_2 GIT_CONFIG_VALUE_2 GIT_ASKPASS GIT_ASKPASS_REQUIRE GIT_TERMINAL_PROMPT
`;
};
