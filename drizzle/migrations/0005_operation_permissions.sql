UPDATE "permissions" SET "public_id" = 'users:profile.read' WHERE "numeric_id" = 0;--> statement-breakpoint
UPDATE "permissions" SET "public_id" = 'users:profile.write' WHERE "numeric_id" = 1;--> statement-breakpoint
ALTER TABLE "permissions" DROP COLUMN "numeric_id";--> statement-breakpoint
INSERT INTO "permissions" ("id", "public_id", "created_at", "updated_at") VALUES ('github:user.read', 'github:user.read', now(), now()), ('github:avatar.read', 'github:avatar.read', now(), now()), ('github:repositories.read', 'github:repositories.read', now(), now()) ON CONFLICT ("public_id") DO NOTHING;
