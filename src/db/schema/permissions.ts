import { createId } from "@paralleldrive/cuid2";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const permissions = pgTable("permissions", {
    id: text("id")
        .primaryKey()
        .$defaultFn(() => createId()),
    publicId: text("public_id")
        .notNull()
        .unique()
        .$defaultFn(() => createId()),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
        .defaultNow()
        .notNull()
        .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
});

export type PermissionRow = typeof permissions.$inferSelect;
export type NewPermissionRow = typeof permissions.$inferInsert;
