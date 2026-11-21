import { boolean, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * `@better-auth/oauth-provider`'s `oauthResource` model. A resource server
 * (RFC 8707) that access tokens can be issued for, with its own token
 * lifetimes and signing configuration.
 */
export const oauthResources = pgTable(
  'oauth_resource',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull().unique(),
    name: text('name').notNull(),
    accessTokenTtl: integer('access_token_ttl'),
    refreshTokenTtl: integer('refresh_token_ttl'),
    signingAlgorithm: text('signing_algorithm'),
    signingKeyId: text('signing_key_id'),
    allowedScopes: text('allowed_scopes').array(),
    customClaims: jsonb('custom_claims'),
    dpopBoundAccessTokensRequired: boolean('dpop_bound_access_tokens_required'),
    disabled: boolean('disabled'),
    createdAt: timestamp('created_at'),
    updatedAt: timestamp('updated_at'),
    policyVersion: integer('policy_version'),
    metadata: jsonb('metadata'),
  },
  (t) => [index('oauthResource_identifier_idx').on(t.identifier)]
);

export type OAuthResource = typeof oauthResources.$inferSelect;
export type NewOAuthResource = typeof oauthResources.$inferInsert;
