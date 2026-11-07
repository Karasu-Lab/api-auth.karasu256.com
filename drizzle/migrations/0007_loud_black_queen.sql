CREATE TABLE "user_signing_key" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" varchar(128) NOT NULL,
	"name" text NOT NULL,
	"public_key" text NOT NULL,
	"encrypted_private_key" text NOT NULL,
	"public_key_fingerprint" text NOT NULL,
	"github_key_id" bigint,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_signing_key_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
DROP TABLE "tenant_signing_key" CASCADE;--> statement-breakpoint
ALTER TABLE "user_signing_key" ADD CONSTRAINT "user_signing_key_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_signing_key_userId_idx" ON "user_signing_key" USING btree ("user_id");