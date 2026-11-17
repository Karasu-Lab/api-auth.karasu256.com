import { index, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

export const members = pgTable(
    "member",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => organizations.id, { onDelete: "cascade" }),
        userId: varchar("user_id", { length: 128 })
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        role: text("role").default("member").notNull(),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (t) => [
        index("member_organizationId_idx").on(t.organizationId),
        index("member_userId_idx").on(t.userId),
    ],
);

export type Member = typeof members.$inferSelect;
export type NewMember = typeof members.$inferInsert;
