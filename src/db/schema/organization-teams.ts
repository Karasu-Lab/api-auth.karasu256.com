import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const teams = pgTable(
    "team",
    {
        id: text("id").primaryKey(),
        name: text("name").notNull(),
        memberCount: integer("member_count").default(0).notNull(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => organizations.id, { onDelete: "cascade" }),
        createdAt: timestamp("created_at").defaultNow().notNull(),
        updatedAt: timestamp("updated_at")
            .defaultNow()
            .$onUpdate(() => new Date())
            .notNull(),
    },
    (t) => [index("team_organizationId_idx").on(t.organizationId)],
);

export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
