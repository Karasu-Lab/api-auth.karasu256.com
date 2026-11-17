CREATE TABLE "email_challenge" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"hashed_approval_token" text NOT NULL,
	"hashed_otp" text NOT NULL,
	"browser_binding_hash" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"name" text,
	"callback_url" text,
	"ip_address" text,
	"user_agent" text,
	"expires_at" timestamp NOT NULL,
	"approved_at" timestamp,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "email_challenge_hashed_approval_token_unique" UNIQUE("hashed_approval_token")
);
--> statement-breakpoint
CREATE INDEX "emailChallenge_email_idx" ON "email_challenge" USING btree ("email");