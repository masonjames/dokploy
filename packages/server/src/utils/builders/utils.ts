import { dirname, join } from "node:path";
import { quote } from "shell-quote";
import {
	encodeBase64,
	parseEnvironmentKeyValuePair,
	prepareEnvironmentVariables,
} from "../docker/utils";

export const prepareBuildEnvironment = (
	serviceEnv: string | null,
	projectEnv?: string | null,
	environmentEnv?: string | null,
) => {
	const variables = prepareEnvironmentVariables(
		serviceEnv,
		projectEnv,
		environmentEnv,
	);
	const keys: string[] = [];
	const exports: string[] = [];
	for (const variable of variables) {
		const [key, value] = parseEnvironmentKeyValuePair(variable);
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			throw new Error(`Invalid build environment variable name: ${key}`);
		}
		keys.push(key);
		exports.push(`export ${key}=${quote([value])}`);
	}
	return { exports, keys, variables };
};

export const createPrivateBuildValueFileCommand = (
	value: string,
	fileName: string,
) => {
	if (!/^[A-Za-z0-9._-]+$/.test(fileName)) {
		throw new Error("Invalid private build environment file name");
	}
	const encoded = encodeBase64(value);
	const path = `"$DOKPLOY_BUILD_TMPDIR/${fileName}"`;
	return {
		path,
		setup: `(umask 077; printf '%s' ${quote([encoded])} | base64 -d > ${path})`,
		cleanup: `rm -f -- ${path}`,
	};
};

export const createEnvFileCommand = (
	directory: string,
	env: string | null,
	projectEnv?: string | null,
	environmentEnv?: string | null,
) => {
	const envFileContent = prepareEnvironmentVariables(
		env,
		projectEnv,
		environmentEnv,
	).join("\n");

	const encodedContent = encodeBase64(envFileContent || "");
	const envFilePath = join(dirname(directory), ".env");

	return `echo "${encodedContent}" | base64 -d > "${envFilePath}";`;
};
