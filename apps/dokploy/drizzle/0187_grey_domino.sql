CREATE TABLE "immutableReleaseRequest" (
	"idempotencyKey" text PRIMARY KEY NOT NULL,
	"applicationId" text NOT NULL,
	"organizationId" text NOT NULL,
	"expectedImage" text NOT NULL,
	"expectedGeneration" text NOT NULL,
	"expectedNonImageConfigHash" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"physicalJobId" text NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"createdAt" text NOT NULL,
	"updatedAt" text NOT NULL,
	CONSTRAINT "immutableReleaseRequest_physicalJobId_unique" UNIQUE("physicalJobId")
);
--> statement-breakpoint
ALTER TABLE "immutableReleaseRequest" ADD CONSTRAINT "immutableReleaseRequest_applicationId_application_applicationId_fk" FOREIGN KEY ("applicationId") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;