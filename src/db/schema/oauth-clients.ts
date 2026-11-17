import {
    boolean,
    index,
    jsonb,
    pgTable,
    text,
    timestamp,
    varchar,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * `@better-auth/oauth-provider`'s `oauthClient` model. Replaces the old
 * `oauth_clients` table — third-party apps registered against the
 * authorization server hosted on auth.karasu256.com.
 */
export const oauthClients = pgTable(
    "oauth_client",
    {
        id: text("id").primaryKey(),
        clientId: text("client_id").notNull().unique(),
        clientSecret: text("client_secret"),
        clientDiscoveryId: text("client_discovery_id"),
        disabled: boolean("disabled").default(false),
        skipConsent: boolean("skip_consent"),
        enableEndSession: boolean("enable_end_session"),
        subjectType: text("subject_type"),
        scopes: text("scopes").array(),
        clientCredentialsScopes: text("client_credentials_scopes").array(),
        userId: varchar("user_id", { length: 128 }).references(() => users.id, {
            onDelete: "cascade",
        }),
        createdAt: timestamp("created_at"),
        updatedAt: timestamp("updated_at"),
        name: text("name"),
        uri: text("uri"),
        icon: text("icon"),
        contacts: text("contacts").array(),
        tos: text("tos"),
        policy: text("policy"),
        softwareId: text("software_id"),
        softwareVersion: text("software_version"),
        softwareStatement: text("software_statement"),
        redirectUris: text("redirect_uris").array().notNull(),
        postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
        backchannelLogoutUri: text("backchannel_logout_uri"),
        backchannelLogoutSessionRequired: boolean(
            "backchannel_logout_session_required",
        ),
        tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
        applicationType: text("application_type"),
        jwks: text("jwks"),
        jwksUri: text("jwks_uri"),
        grantTypes: text("grant_types").array(),
        responseTypes: text("response_types").array(),
        public: boolean("public"),
        type: text("type"),
        requirePKCE: boolean("require_pkce"),
        dpopBoundAccessTokens: boolean("dpop_bound_access_tokens"),
        referenceId: text("reference_id"),
        metadata: jsonb("metadata"),
    },
    (t) => [index("oauthClient_userId_idx").on(t.userId)],
);

export type OAuthClient = typeof oauthClients.$inferSelect;
export type NewOAuthClient = typeof oauthClients.$inferInsert;
