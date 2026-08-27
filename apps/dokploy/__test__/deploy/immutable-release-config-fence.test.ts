import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const migration = readFileSync(
	new URL("../../drizzle/0188_crazy_lionheart.sql", import.meta.url),
	"utf8",
);
const imageOnlyCorrection = readFileSync(
	new URL(
		"../../drizzle/0189_dockhand_image_only_revision.sql",
		import.meta.url,
	),
	"utf8",
);
const applicationImageService = readFileSync(
	new URL(
		"../../../../packages/server/src/services/application-image.ts",
		import.meta.url,
	),
	"utf8",
);
const mountService = readFileSync(
	new URL("../../../../packages/server/src/services/mount.ts", import.meta.url),
	"utf8",
);

test("database migration fences secret-bearing configuration during releases", () => {
	for (const trigger of [
		"dockhand_guard_application_release_config",
		"dockhand_guard_application_release_delete",
		"dockhand_guard_environment_release_config",
		"dockhand_guard_project_release_config",
		"dockhand_guard_mount_release_config",
		"dockhand_guard_domain_release_config",
		"dockhand_guard_port_release_config",
	]) {
		expect(migration).toContain(trigger);
	}
	expect(migration).toContain("'reserved', 'queued', 'running'");
	expect(migration).toContain("pg_advisory_xact_lock");
	expect(migration).toContain(
		"application release revision is database managed",
	);
	expect(migration).toContain("internal_revision_bump := COALESCE(");
	expect(migration).toContain('"releaseConfigRevision" + 1');
	expect(migration).not.toContain("SECRET_TOKEN");
});

test("serializes parent membership and file-backed mount deletion", () => {
	for (const functionName of [
		"dockhand_guard_environment_release_config",
		"dockhand_guard_project_release_config",
	]) {
		const start = migration.indexOf(`FUNCTION "${functionName}"`);
		const end = migration.indexOf("$$;", start);
		const body = migration.slice(start, end);
		expect(body.indexOf("pg_advisory_xact_lock(20260827)")).toBeGreaterThan(-1);
		expect(body.indexOf("pg_advisory_xact_lock(20260827)")).toBeLessThan(
			body.indexOf('FROM "application"'),
		);
	}
	expect(
		migration.slice(
			migration.indexOf('FUNCTION "dockhand_assert_release_targets_unfenced"'),
			migration.indexOf(
				"$$;",
				migration.indexOf(
					'FUNCTION "dockhand_assert_release_targets_unfenced"',
				),
			),
		),
	).toContain("pg_advisory_xact_lock(20260827)");

	const guardedDeleteStart = mountService.indexOf(
		'if (mount.type === "file" && applicationId)',
	);
	const guardedDelete = mountService.slice(
		guardedDeleteStart,
		mountService.indexOf('if (mount.type === "file")', guardedDeleteStart),
	);
	expect(guardedDelete).toContain("pg_advisory_xact_lock(20260827)");
	expect(guardedDelete.indexOf("activeRelease")).toBeLessThan(
		guardedDelete.indexOf("deleteFileMount(mountId)"),
	);
});

test("image-only CAS preserves the non-image configuration revision", () => {
	expect(imageOnlyCorrection).toContain(
		"to_jsonb(NEW) - ARRAY['applicationStatus', 'dockerImage', 'releaseConfigRevision']",
	);
	expect(imageOnlyCorrection).toContain(
		"to_jsonb(OLD) - ARRAY['applicationStatus', 'dockerImage', 'releaseConfigRevision']",
	);
	expect(imageOnlyCorrection).toContain(
		'NEW."releaseConfigRevision" := OLD."releaseConfigRevision" + 1',
	);
	expect(imageOnlyCorrection).toContain(
		'image_changed := NEW."dockerImage" IS DISTINCT FROM OLD."dockerImage"',
	);
	expect(imageOnlyCorrection).toContain(
		"current_setting('dockhand.internal_image_cas', true) = '1'",
	);
	expect(imageOnlyCorrection).toContain(
		"IF configuration_changed OR image_changed THEN",
	);
	expect(imageOnlyCorrection).toContain(
		"IF configuration_changed OR (image_changed AND NOT internal_image_cas) THEN",
	);
	expect(imageOnlyCorrection.indexOf("OR image_changed THEN")).toBeLessThan(
		imageOnlyCorrection.indexOf("PERFORM"),
	);
	expect(imageOnlyCorrection.indexOf("PERFORM")).toBeLessThan(
		imageOnlyCorrection.indexOf(
			"OR (image_changed AND NOT internal_image_cas) THEN",
		),
	);
	expect(applicationImageService).toContain(
		"set_config('dockhand.internal_image_cas', '1', true)",
	);
	expect(applicationImageService).toContain(
		"set_config('dockhand.internal_image_cas', '0', true)",
	);
	expect(imageOnlyCorrection).not.toContain("SECRET_TOKEN");
});
