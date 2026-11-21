import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * `@better-auth/oauth-provider`'s `oauthClientAssertion` model. Records
 * `private_key_jwt` client assertions (keyed by assertion id) so each one
 * cannot be replayed until it expires.
 */
export const oauthClientAssertions = pgTable('oauth_client_assertion', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
});

export type OAuthClientAssertion = typeof oauthClientAssertions.$inferSelect;
export type NewOAuthClientAssertion = typeof oauthClientAssertions.$inferInsert;
