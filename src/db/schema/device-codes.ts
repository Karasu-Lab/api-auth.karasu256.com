import {
    index,
    integer,
    pgTable,
    text,
    timestamp,
    varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * better-auth's `deviceCode` model for the device-authorization plugin:
 * one row per device sign-in request, holding the device and user codes
 * until the user approves or denies the sign-in or the code expires.
 */
export const deviceCodes = pgTable(
    "device_code",
    {
        id: text("id").primaryKey(),
        deviceCode: text("device_code").notNull().unique(),
        userCode: text("user_code").notNull().unique(),
        userId: varchar("user_id", { length: 128 }).references(() => users.id, {
            onDelete: "cascade",
        }),
        expiresAt: timestamp("expires_at").notNull(),
        status: text("status").notNull(),
        lastPolledAt: timestamp("last_polled_at"),
        pollingInterval: integer("polling_interval"),
        clientId: text("client_id"),
        oauthClientId: text("oauth_client_id"),
        resources: text("resources").array(),
        scope: text("scope"),
        createdAt: timestamp("created_at").defaultNow().notNull(),
        updatedAt: timestamp("updated_at")
            .defaultNow()
            .$onUpdate(() => new Date())
            .notNull(),
    },
    (t) => [index("deviceCode_userId_idx").on(t.userId)],
);

export type DeviceCode = typeof deviceCodes.$inferSelect;
export type NewDeviceCode = typeof deviceCodes.$inferInsert;
