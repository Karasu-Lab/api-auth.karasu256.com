INSERT INTO "permissions" ("id", "public_id", "created_at", "updated_at") VALUES ('users:avatar.delete', 'users:avatar.delete', now(), now()) ON CONFLICT ("public_id") DO NOTHING;
