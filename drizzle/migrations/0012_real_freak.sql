CREATE TYPE "public"."batch_work_status" AS ENUM('pending', 'syncing', 'completed', 'error');--> statement-breakpoint
CREATE TABLE "batch_works" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"type" varchar(64) NOT NULL,
	"status" "batch_work_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"context" text NOT NULL,
	"scheduled_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "batch_works_status_scheduled_at_idx" ON "batch_works" USING btree ("status","scheduled_at");