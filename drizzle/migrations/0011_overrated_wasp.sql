CREATE TABLE "tenant_types" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_types" ADD CONSTRAINT "tenant_types_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;