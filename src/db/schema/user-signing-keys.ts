import { createId } from "@paralleldrive/cuid2";
import {
    bigint,
    boolean,
    index,
    pgTable,
    text,
    timestamp,
    varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export const userSigningKeys = pgTable(
    "user_signing_key",
    {
        id: text("id")
            .primaryKey()
            .$defaultFn(() => createId()),
        userId: varchar("user_id", { length: 128 })
            .notNull()
            .unique()
            .references(() => users.id, { onDelete: "cascade" }),
        name: text("name").notNull(),
        publicKey: text("public_key").notNull(),
        encryptedPrivateKey: text("encrypted_private_key").notNull(),
        publicKeyFingerprint: text("public_key_fingerprint").notNull(),
        githubKeyId: bigint("github_key_id", { mode: "number" }),
        enabled: boolean("enabled").default(true).notNull(),
        createdAt: timestamp("created_at").defaultNow().notNull(),
        updatedAt: timestamp("updated_at")
            .defaultNow()
            .$onUpdate(() => new Date())
            .notNull(),
    },
    (t) => [index("user_signing_key_userId_idx").on(t.userId)],
);

export type UserSigningKey = typeof userSigningKeys.$inferSelect;
export type NewUserSigningKey = typeof userSigningKeys.$inferInsert;
