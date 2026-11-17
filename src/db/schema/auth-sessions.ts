import { index, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { users } from "./users";

export const sessions = pgTable(
    "session",
    {
        id: text("id").primaryKey(),
        expiresAt: timestamp("expires_at").notNull(),
        token: text("token").notNull().unique(),
        createdAt: timestamp("created_at").defaultNow().notNull(),
        updatedAt: timestamp("updated_at")
            .$onUpdate(() => new Date())
            .notNull(),
        ipAddress: text("ip_address"),
        userAgent: text("user_agent"),
        userId: varchar("user_id", { length: 128 })
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        activeOrganizationId: text("active_organization_id"),
        activeTeamId: text("active_team_id"),
    },
    (t) => [index("session_userId_idx").on(t.userId)],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
