import { getEnvironmentVariablesObject } from "@dokploy/server/utils/docker/utils";
import { quote } from "shell-quote";
import {
	getBuildAppDirectory,
	getDockerContextPath,
} from "../filesystem/directory";
import type { ApplicationNested } from ".";
import {
	createEnvFileCommand,
	createPrivateBuildValueFileCommand,
	prepareBuildEnvironment,
} from "./utils";

export const getDockerCommand = (application: ApplicationNested) => {
	const {
		appName,
		env,
		publishDirectory,
		buildArgs,
		buildSecrets,
		dockerBuildStage,
		cleanCache,
		createEnvFile,
	} = application;
	const dockerFilePath = getBuildAppDirectory(application);

	try {
		const image = `${appName}`;

		const defaultContextPath =
			dockerFilePath.substring(0, dockerFilePath.lastIndexOf("/") + 1) || ".";

		const dockerContextPath =
			getDockerContextPath(application) || defaultContextPath;

		const commandArgs = ["build", "-t", image, "-f", dockerFilePath, "."];

		if (dockerBuildStage) {
			commandArgs.push("--target", dockerBuildStage);
		}

		if (cleanCache) {
			commandArgs.push("--no-cache");
		}

		const buildEnvironment = prepareBuildEnvironment(
			buildArgs,
			application.environment.project.env,
			application.environment.env,
		);

		for (const key of buildEnvironment.keys) {
			// A value-less build arg inherits the value from the Docker CLI's
			// environment, so the reversible value never appears in child argv.
			commandArgs.push("--build-arg", key);
		}

		const secrets = getEnvironmentVariablesObject(
			buildSecrets,
			application.environment.project.env,
			application.environment.env,
		);

		const secretFiles = Object.entries(secrets).map(([key, value]) => {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
				throw new Error(`Invalid build secret name: ${key}`);
			}
			return {
				key,
				...createPrivateBuildValueFileCommand(value, `docker-secret-${key}`),
			};
		});

		/*
			Do not generate an environment file when publishDirectory is specified,
			as it could be publicly exposed.
			Also respect the createEnvFile flag.
		*/
		let command = "";
		if (!publishDirectory && createEnvFile) {
			command += createEnvFileCommand(
				dockerFilePath,
				env,
				application.environment.project.env,
				application.environment.env,
			);
		}

		for (const secret of secretFiles) {
			commandArgs.push(
				"--secret",
				`type=file,id=${secret.key},src=${secret.path}`,
			);
		}

		command += `
echo ${quote([`Building ${appName}`])} ;
cd ${quote([dockerContextPath])} || {
  echo ${quote([`❌ The path ${dockerContextPath} does not exist`])} ;
  exit 1;
}

${buildEnvironment.exports.join("\n")}
${secretFiles.map(({ setup }) => setup).join("\n")}
docker ${commandArgs.join(" ")} || {
  ${secretFiles.map(({ cleanup }) => cleanup).join("\n")}
  echo "❌ Docker build failed" ;
  exit 1;
}
${secretFiles.map(({ cleanup }) => cleanup).join("\n")}
echo "✅ Docker build completed." ;
		`;

		return command;
	} catch (error) {
		throw error;
	}
};
