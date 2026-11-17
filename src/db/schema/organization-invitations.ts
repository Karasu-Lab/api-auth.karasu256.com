import { index, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { teams } from "./organization-teams";
import { organizations } from "./organizations";
import { users } from "./users";

export const invitations = pgTable(
    "invitation",
    {
        id: text("id").primaryKey(),
        organizationId: text("organization_id")
            .notNull()
            .references(() => organizations.id, { onDelete: "cascade" }),
        email: text("email").notNull(),
        role: text("role"),
        teamId: text("team_id").references(() => teams.id, {
            onDelete: "set null",
        }),
        status: text("status").default("pending").notNull(),
        expiresAt: timestamp("expires_at").notNull(),
        createdAt: timestamp("created_at").defaultNow().notNull(),
        inviterId: varchar("inviter_id", { length: 128 })
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
    },
    (t) => [
        index("invitation_organizationId_idx").on(t.organizationId),
        index("invitation_email_idx").on(t.email),
    ],
);

export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
