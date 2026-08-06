import { getBuildAppDirectory } from "../filesystem/directory";
import type { ApplicationNested } from ".";
import { prepareBuildEnvironment } from "./utils";

export const getPaketoCommand = (application: ApplicationNested) => {
	const { env, appName, cleanCache } = application;

	const buildAppDirectory = getBuildAppDirectory(application);
	const buildEnvironment = prepareBuildEnvironment(
		env,
		application.environment.project.env,
		application.environment.env,
	);

	const args = [
		"build",
		appName,
		"--path",
		buildAppDirectory,
		"--builder",
		"paketobuildpacks/builder-jammy-full",
	];

	if (cleanCache) {
		args.push("--clear-cache");
	}

	for (const key of buildEnvironment.keys) {
		// A value-less pack env argument reads the value from the private build
		// script's process environment and keeps the value out of child argv.
		args.push("--env", key);
	}

	const command = `pack ${args.join(" ")}`;
	const bashCommand = `
${buildEnvironment.exports.join("\n")}
echo "Starting Paketo build..." ;
${command} || { 
  echo "❌ Paketo build failed" ;
  exit 1;
}
echo "✅ Paketo build completed." ;
		`;

	return bashCommand;
};
