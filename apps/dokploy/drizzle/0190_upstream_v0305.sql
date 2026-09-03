ALTER TYPE "public"."DnsProviderType" ADD VALUE 'porkbun';--> statement-breakpoint
ALTER TYPE "public"."VaultProviderType" ADD VALUE 'phase';--> statement-breakpoint
ALTER TABLE "network" ADD COLUMN "dockerId" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "onboardingCompletedAt" timestamp;--> statement-breakpoint
-- Preserve the upstream v0.30.5 data migrations that schema generation cannot infer.
UPDATE "organization_role" AS r
SET "permission" = jsonb_set(
	r."permission"::jsonb,
	'{server}',
	(r."permission"::jsonb->'server') || '["terminal"]'::jsonb
)::text
WHERE jsonb_typeof(r."permission"::jsonb->'server') = 'array'
AND r."permission"::jsonb->'server' @> '["read"]'::jsonb
AND NOT r."permission"::jsonb->'server' @> '["terminal"]'::jsonb;--> statement-breakpoint
-- Existing users should not be forced through the new onboarding wizard.
UPDATE "user" SET "onboardingCompletedAt" = now()
WHERE "onboardingCompletedAt" IS NULL;
