import { index, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { teams } from "./organization-teams";
import { users } from "./users";

export const teamMembers = pgTable(
    "team_member",
    {
        id: text("id").primaryKey(),
        teamId: text("team_id")
            .notNull()
            .references(() => teams.id, { onDelete: "cascade" }),
        userId: varchar("user_id", { length: 128 })
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        membershipKey: text("membership_key").unique(),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (t) => [
        index("teamMember_teamId_idx").on(t.teamId),
        index("teamMember_userId_idx").on(t.userId),
    ],
);

export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;
