ALTER TABLE "application" ADD COLUMN "releaseConfigRevision" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "dockhand_assert_release_targets_unfenced"(target_application_ids text[])
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
	target_application_id text;
BEGIN
	PERFORM pg_advisory_xact_lock(20260827);
	FOR target_application_id IN
		SELECT DISTINCT unnest(target_application_ids) ORDER BY 1
	LOOP
		IF target_application_id IS NOT NULL THEN
			PERFORM pg_advisory_xact_lock(hashtextextended(target_application_id, 20260827));
		END IF;
	END LOOP;
	IF EXISTS (
		SELECT 1 FROM "immutableReleaseRequest"
		WHERE "applicationId" = ANY(target_application_ids)
			AND "status" IN ('reserved', 'queued', 'running')
	) THEN
		RAISE EXCEPTION 'application release configuration is fenced';
	END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "dockhand_bump_release_target_revisions"(target_application_ids text[])
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM set_config('dockhand.internal_release_revision', '1', true);
	UPDATE "application"
	SET "releaseConfigRevision" = "releaseConfigRevision" + 1
	WHERE "applicationId" = ANY(target_application_ids);
	PERFORM set_config('dockhand.internal_release_revision', '0', true);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "dockhand_guard_application_release_config"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	configuration_changed boolean;
	internal_revision_bump boolean;
BEGIN
	configuration_changed :=
		(to_jsonb(NEW) - ARRAY['applicationStatus', 'releaseConfigRevision'])
		IS DISTINCT FROM
		(to_jsonb(OLD) - ARRAY['applicationStatus', 'releaseConfigRevision']);
	internal_revision_bump := COALESCE(
		current_setting('dockhand.internal_release_revision', true) = '1',
		false
	);
	IF configuration_changed THEN
		PERFORM "dockhand_assert_release_targets_unfenced"(ARRAY[OLD."applicationId"]);
		NEW."releaseConfigRevision" := OLD."releaseConfigRevision" + 1;
	ELSIF NEW."releaseConfigRevision" IS DISTINCT FROM OLD."releaseConfigRevision" THEN
		IF NOT internal_revision_bump OR NEW."releaseConfigRevision" <> OLD."releaseConfigRevision" + 1 THEN
			RAISE EXCEPTION 'application release revision is database managed';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "dockhand_guard_application_release_config"
BEFORE UPDATE ON "application"
FOR EACH ROW EXECUTE FUNCTION "dockhand_guard_application_release_config"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "dockhand_guard_application_release_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM "dockhand_assert_release_targets_unfenced"(ARRAY[OLD."applicationId"]);
	RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "dockhand_guard_application_release_delete"
BEFORE DELETE ON "application"
FOR EACH ROW EXECUTE FUNCTION "dockhand_guard_application_release_delete"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "dockhand_guard_environment_release_config"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	target_application_ids text[];
	target_environment_id text;
BEGIN
	PERFORM pg_advisory_xact_lock(20260827);
	target_environment_id := COALESCE(NEW."environmentId", OLD."environmentId");
	SELECT COALESCE(array_agg("applicationId" ORDER BY "applicationId"), ARRAY[]::text[])
	INTO target_application_ids FROM "application"
	WHERE "environmentId" = target_environment_id;
	PERFORM "dockhand_assert_release_targets_unfenced"(target_application_ids);
	PERFORM "dockhand_bump_release_target_revisions"(target_application_ids);
	IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "dockhand_guard_environment_release_config"
BEFORE UPDATE OF "env", "projectId" OR DELETE ON "environment"
FOR EACH ROW EXECUTE FUNCTION "dockhand_guard_environment_release_config"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "dockhand_guard_project_release_config"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	target_application_ids text[];
	target_project_id text;
BEGIN
	PERFORM pg_advisory_xact_lock(20260827);
	target_project_id := COALESCE(NEW."projectId", OLD."projectId");
	SELECT COALESCE(array_agg(application."applicationId" ORDER BY application."applicationId"), ARRAY[]::text[])
	INTO target_application_ids
	FROM "application" application
	JOIN "environment" environment ON environment."environmentId" = application."environmentId"
	WHERE environment."projectId" = target_project_id;
	PERFORM "dockhand_assert_release_targets_unfenced"(target_application_ids);
	PERFORM "dockhand_bump_release_target_revisions"(target_application_ids);
	IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "dockhand_guard_project_release_config"
BEFORE UPDATE OF "env" OR DELETE ON "project"
FOR EACH ROW EXECUTE FUNCTION "dockhand_guard_project_release_config"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "dockhand_guard_child_release_config"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	target_application_ids text[];
BEGIN
	IF TG_OP = 'INSERT' THEN
		target_application_ids := ARRAY[NEW."applicationId"];
	ELSIF TG_OP = 'DELETE' THEN
		target_application_ids := ARRAY[OLD."applicationId"];
	ELSE
		target_application_ids := ARRAY[OLD."applicationId", NEW."applicationId"];
	END IF;
	target_application_ids := array_remove(target_application_ids, NULL);
	PERFORM "dockhand_assert_release_targets_unfenced"(target_application_ids);
	PERFORM "dockhand_bump_release_target_revisions"(target_application_ids);
	IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "dockhand_guard_mount_release_config"
BEFORE INSERT OR UPDATE OR DELETE ON "mount"
FOR EACH ROW EXECUTE FUNCTION "dockhand_guard_child_release_config"();
--> statement-breakpoint
CREATE TRIGGER "dockhand_guard_domain_release_config"
BEFORE INSERT OR UPDATE OR DELETE ON "domain"
FOR EACH ROW EXECUTE FUNCTION "dockhand_guard_child_release_config"();
--> statement-breakpoint
CREATE TRIGGER "dockhand_guard_port_release_config"
BEFORE INSERT OR UPDATE OR DELETE ON "port"
FOR EACH ROW EXECUTE FUNCTION "dockhand_guard_child_release_config"();
