import { db } from "@dokploy/server/db";
import { applications } from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";

export type PrepareImmutableApplicationImageInput = {
	applicationId: string;
	expectedCurrentImage: string;
	candidateImage: string;
};

const IMMUTABLE_IMAGE_RE = /@sha256:[a-f0-9]{64}$/;

/**
 * Atomically compare-and-swap only an application's Docker image reference.
 * Registry URL and credentials are deliberately neither selected for return
 * nor written, so release automation cannot clear or disclose them.
 */
export const prepareImmutableApplicationImage = async ({
	applicationId,
	expectedCurrentImage,
	candidateImage,
}: PrepareImmutableApplicationImageInput) => {
	if (!IMMUTABLE_IMAGE_RE.test(candidateImage)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "candidateImage must be pinned by sha256 digest",
		});
	}

	const updated = await db
		.update(applications)
		.set({ dockerImage: candidateImage })
		.where(
			and(
				eq(applications.applicationId, applicationId),
				eq(applications.sourceType, "docker"),
				eq(applications.dockerImage, expectedCurrentImage),
			),
		)
		.returning({
			applicationId: applications.applicationId,
			dockerImage: applications.dockerImage,
			sourceType: applications.sourceType,
			registryUrl: applications.registryUrl,
			usernameConfigured: sql<boolean>`${applications.username} is not null and ${applications.username} <> ''`,
			passwordConfigured: sql<boolean>`${applications.password} is not null and ${applications.password} <> ''`,
		});

	const row = updated[0];
	if (row) {
		const provider = {
			sourceType: row.sourceType,
			registryUrl: row.registryUrl,
			usernameConfigured: row.usernameConfigured,
			passwordConfigured: row.passwordConfigured,
		};
		return {
			applicationId: row.applicationId,
			previous: {
				dockerImage: expectedCurrentImage,
				...provider,
			},
			current: {
				dockerImage: row.dockerImage,
				...provider,
			},
		};
	}

	const current = await db.query.applications.findFirst({
		where: eq(applications.applicationId, applicationId),
		columns: {
			applicationId: true,
			dockerImage: true,
			sourceType: true,
		},
	});
	if (!current) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Application not found",
		});
	}
	if (current.sourceType !== "docker") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Immutable image preparation requires a Docker provider application",
		});
	}
	throw new TRPCError({
		code: "CONFLICT",
		message: `Application image changed before preparation (expected ${expectedCurrentImage}, found ${current.dockerImage ?? "<unset>"})`,
	});
};
