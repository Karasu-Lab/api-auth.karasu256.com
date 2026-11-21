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
import { users } from "./users";

/**
 * `@better-auth/oauth-provider`'s `oauthRefreshToken` model. An opaque
 * refresh token created with the `offline_access` scope, linked to a session.
 */
export const oauthRefreshTokens = pgTable(
    "oauth_refresh_token",
    {
        id: text("id").primaryKey(),
        token: text("token").notNull().unique(),
        clientId: text("client_id")
            .notNull()
            .references(() => oauthClients.clientId, { onDelete: "cascade" }),
        sessionId: text("session_id").references(() => sessions.id, {
            onDelete: "set null",
        }),
        userId: varchar("user_id", { length: 128 })
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        referenceId: text("reference_id"),
        authorizationCodeId: text("authorization_code_id"),
        resources: text("resources").array(),
        requestedUserInfoClaims: text("requested_user_info_claims").array(),
        expiresAt: timestamp("expires_at"),
        createdAt: timestamp("created_at"),
        revoked: timestamp("revoked"),
        rotatedAt: timestamp("rotated_at"),
        rotationReplayResponse: text("rotation_replay_response"),
        rotationReplayExpiresAt: timestamp("rotation_replay_expires_at"),
        authTime: timestamp("auth_time"),
        confirmation: jsonb("confirmation"),
        scopes: text("scopes").array().notNull(),
    },
    (t) => [
        index("oauthRefreshToken_clientId_idx").on(t.clientId),
        index("oauthRefreshToken_sessionId_idx").on(t.sessionId),
        index("oauthRefreshToken_userId_idx").on(t.userId),
    ],
);

export type OAuthRefreshToken = typeof oauthRefreshTokens.$inferSelect;
export type NewOAuthRefreshToken = typeof oauthRefreshTokens.$inferInsert;
