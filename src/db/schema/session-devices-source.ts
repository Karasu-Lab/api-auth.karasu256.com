import { index, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sessions } from "./auth-sessions";
import { users } from "./users";

export const sessionDevicesSource = pgTable(
    "session_devices_source",
    {
        sessionId: text("session_id")
            .primaryKey()
            .references(() => sessions.id, { onDelete: "cascade" }),
        userId: varchar("user_id", { length: 128 })
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        source: text("source").notNull(),
        createdAt: timestamp("created_at").defaultNow().notNull(),
        updatedAt: timestamp("updated_at")
            .defaultNow()
            .$onUpdate(() => new Date())
            .notNull(),
    },
    (t) => [index("session_devices_source_userId_idx").on(t.userId)],
);

export type SessionDeviceSource = typeof sessionDevicesSource.$inferSelect;
export type NewSessionDeviceSource = typeof sessionDevicesSource.$inferInsert;
