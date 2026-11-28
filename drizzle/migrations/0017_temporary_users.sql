CREATE TABLE "temporary_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" varchar(128) NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "temporary_users" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"name" varchar(255),
	"email" varchar(255),
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" varchar(2048),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "temporary_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "temporary_accounts" ADD CONSTRAINT "temporary_accounts_user_id_temporary_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."temporary_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "temporary_account_userId_idx" ON "temporary_accounts" USING btree ("user_id");