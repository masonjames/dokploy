import {
	claimImmutableImageDeployment,
	deployApplication,
	deployCompose,
	deployPreviewApplication,
	finishImmutableImageDeployment,
	rebuildApplication,
	rebuildCompose,
	rebuildPreviewApplication,
	updateApplicationStatus,
	updateCompose,
	updatePreviewDeployment,
} from "@dokploy/server";
import type { InMemoryJob } from "./in-memory-queue";

/**
 * Processes a single deployment job. Shared by the in-memory queue worker and
 * (in cloud) the direct background execution path.
 */
export const processDeploymentJob = async (job: InMemoryJob) => {
	let releaseClaimed = false;
	try {
		if (job.data.applicationType === "application") {
			if (job.data.releaseGuard) {
				releaseClaimed = await claimImmutableImageDeployment({
					...job.data.releaseGuard,
					applicationId: job.data.applicationId,
				});
				if (!releaseClaimed) return;
			}
			await updateApplicationStatus(job.data.applicationId, "running");

			if (job.data.type === "redeploy") {
				await rebuildApplication({
					applicationId: job.data.applicationId,
					titleLog: job.data.titleLog,
					descriptionLog: job.data.descriptionLog,
					releaseGuard: job.data.releaseGuard,
				});
			} else if (job.data.type === "deploy") {
				await deployApplication({
					applicationId: job.data.applicationId,
					titleLog: job.data.titleLog,
					descriptionLog: job.data.descriptionLog,
				});
			}
			if (job.data.releaseGuard && releaseClaimed) {
				await finishImmutableImageDeployment(
					{
						...job.data.releaseGuard,
						applicationId: job.data.applicationId,
					},
					"done",
				);
			}
		} else if (job.data.applicationType === "compose") {
			await updateCompose(job.data.composeId, {
				composeStatus: "running",
			});
			if (job.data.type === "deploy") {
				await deployCompose({
					composeId: job.data.composeId,
					titleLog: job.data.titleLog,
					descriptionLog: job.data.descriptionLog,
				});
			} else if (job.data.type === "redeploy") {
				await rebuildCompose({
					composeId: job.data.composeId,
					titleLog: job.data.titleLog,
					descriptionLog: job.data.descriptionLog,
				});
			}
		} else if (job.data.applicationType === "application-preview") {
			await updatePreviewDeployment(job.data.previewDeploymentId, {
				previewStatus: "running",
			});

			if (job.data.type === "redeploy") {
				await rebuildPreviewApplication({
					applicationId: job.data.applicationId,
					titleLog: job.data.titleLog,
					descriptionLog: job.data.descriptionLog,
					previewDeploymentId: job.data.previewDeploymentId,
				});
			} else if (job.data.type === "deploy") {
				await deployPreviewApplication({
					applicationId: job.data.applicationId,
					titleLog: job.data.titleLog,
					descriptionLog: job.data.descriptionLog,
					previewDeploymentId: job.data.previewDeploymentId,
				});
			}
		}
	} catch (error) {
		if (job.data.applicationType === "application" && job.data.releaseGuard) {
			console.error("Governed immutable deployment failed");
		} else {
			console.log("Error", error);
		}
		if (
			job.data.applicationType === "application" &&
			job.data.releaseGuard &&
			releaseClaimed
		) {
			await finishImmutableImageDeployment(
				{
					...job.data.releaseGuard,
					applicationId: job.data.applicationId,
				},
				"error",
			);
		}
		if (job.data.applicationType === "application" && job.data.releaseGuard) {
			throw new Error("Governed immutable deployment failed");
		}
		throw error;
	}
};
