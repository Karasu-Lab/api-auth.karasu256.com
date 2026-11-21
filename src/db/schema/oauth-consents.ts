import { index, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { oauthClients } from "./oauth-clients";
import { users } from "./users";

/**
 * `@better-auth/oauth-provider`'s `oauthConsent` model. Tracks which scopes
 * a user has granted to a client — backs the "authorized apps" list/revoke UI.
 */
export const oauthConsents = pgTable(
    "oauth_consent",
    {
        id: text("id").primaryKey(),
        clientId: text("client_id")
            .notNull()
            .references(() => oauthClients.clientId, { onDelete: "cascade" }),
        userId: varchar("user_id", { length: 128 }).references(() => users.id, {
            onDelete: "cascade",
        }),
        referenceId: text("reference_id"),
        resources: text("resources").array(),
        requestedUserInfoClaims: text("requested_user_info_claims").array(),
        scopes: text("scopes").array().notNull(),
        createdAt: timestamp("created_at"),
        updatedAt: timestamp("updated_at"),
    },
    (t) => [
        index("oauthConsent_clientId_idx").on(t.clientId),
        index("oauthConsent_userId_idx").on(t.userId),
    ],
);

export type OAuthConsent = typeof oauthConsents.$inferSelect;
export type NewOAuthConsent = typeof oauthConsents.$inferInsert;
