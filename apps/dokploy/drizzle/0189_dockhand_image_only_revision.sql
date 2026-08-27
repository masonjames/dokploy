-- Image-only Dockhand CAS must preserve the non-image configuration revision.
-- Every other application-field change remains fenced and revision-bumping.
CREATE OR REPLACE FUNCTION "dockhand_guard_application_release_config"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	configuration_changed boolean;
	image_changed boolean;
	internal_image_cas boolean;
	internal_revision_bump boolean;
BEGIN
	configuration_changed :=
		(to_jsonb(NEW) - ARRAY['applicationStatus', 'dockerImage', 'releaseConfigRevision'])
		IS DISTINCT FROM
		(to_jsonb(OLD) - ARRAY['applicationStatus', 'dockerImage', 'releaseConfigRevision']);
	image_changed := NEW."dockerImage" IS DISTINCT FROM OLD."dockerImage";
	internal_image_cas := COALESCE(
		current_setting('dockhand.internal_image_cas', true) = '1',
		false
	);
	internal_revision_bump := COALESCE(
		current_setting('dockhand.internal_release_revision', true) = '1',
		false
	);
	IF configuration_changed OR image_changed THEN
		PERFORM "dockhand_assert_release_targets_unfenced"(ARRAY[OLD."applicationId"]);
	END IF;
	IF configuration_changed OR (image_changed AND NOT internal_image_cas) THEN
		NEW."releaseConfigRevision" := OLD."releaseConfigRevision" + 1;
	ELSIF NEW."releaseConfigRevision" IS DISTINCT FROM OLD."releaseConfigRevision" THEN
		IF NOT internal_revision_bump OR NEW."releaseConfigRevision" <> OLD."releaseConfigRevision" + 1 THEN
			RAISE EXCEPTION 'application release revision is database managed';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
