import {
    index,
    jsonb,
    pgTable,
    text,
    timestamp,
    varchar,
} from "drizzle-orm/pg-core";
import { sessions } from "./auth-sessions";
import { oauthClients } from "./oauth-clients";
import { oauthRefreshTokens } from "./oauth-refresh-tokens";
import { users } from "./users";

/**
 * `@better-auth/oauth-provider`'s `oauthAccessToken` model. Only populated
 * for opaque access tokens (no audience); JWT access tokens are verified
 * locally and never written here. Replaces the old `oauth_access_tokens` table.
 */
export const oauthAccessTokens = pgTable(
    "oauth_access_token",
    {
        id: text("id").primaryKey(),
        token: text("token").unique(),
        clientId: text("client_id")
            .notNull()
            .references(() => oauthClients.clientId, { onDelete: "cascade" }),
        sessionId: text("session_id").references(() => sessions.id, {
            onDelete: "set null",
        }),
        userId: varchar("user_id", { length: 128 }).references(() => users.id, {
            onDelete: "cascade",
        }),
        referenceId: text("reference_id"),
        authorizationCodeId: text("authorization_code_id"),
        resources: text("resources").array(),
        requestedUserInfoClaims: text("requested_user_info_claims").array(),
        refreshId: text("refresh_id").references(() => oauthRefreshTokens.id, {
            onDelete: "cascade",
        }),
        expiresAt: timestamp("expires_at"),
        createdAt: timestamp("created_at"),
        revoked: timestamp("revoked"),
        confirmation: jsonb("confirmation"),
        scopes: text("scopes").array().notNull(),
    },
    (t) => [
        index("oauthAccessToken_clientId_idx").on(t.clientId),
        index("oauthAccessToken_sessionId_idx").on(t.sessionId),
        index("oauthAccessToken_userId_idx").on(t.userId),
        index("oauthAccessToken_refreshId_idx").on(t.refreshId),
    ],
);

export type OAuthAccessToken = typeof oauthAccessTokens.$inferSelect;
export type NewOAuthAccessToken = typeof oauthAccessTokens.$inferInsert;
