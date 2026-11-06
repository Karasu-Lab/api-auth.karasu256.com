CREATE TABLE "session_devices_source" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" varchar(128) NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_devices_source" ADD CONSTRAINT "session_devices_source_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_devices_source" ADD CONSTRAINT "session_devices_source_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_devices_source_userId_idx" ON "session_devices_source" USING btree ("user_id");