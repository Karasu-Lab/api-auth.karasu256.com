CREATE TABLE "oauth_client_info" (
	"client_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"author_id" varchar(128),
	"icon_url" text,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_client_info" ADD CONSTRAINT "oauth_client_info_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_info" ADD CONSTRAINT "oauth_client_info_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
INSERT INTO "oauth_client_info" ("client_id", "name", "author_id", "icon_url") SELECT "client_id", "name", "user_id", "icon" FROM "oauth_client" WHERE "name" IS NOT NULL ON CONFLICT ("client_id") DO NOTHING;