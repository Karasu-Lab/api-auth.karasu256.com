import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { oauthClients } from './oauth-clients';
import { oauthResources } from './oauth-resources';

/**
 * `@better-auth/oauth-provider`'s `oauthClientResource` model. Links an
 * OAuth client to the resource servers it may request access tokens for.
 */
export const oauthClientResources = pgTable(
  'oauth_client_resource',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    resourceId: text('resource_id')
      .notNull()
      .references(() => oauthResources.id, { onDelete: 'cascade' }),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at'),
  },
  (t) => [index('oauthClientResource_clientId_idx').on(t.clientId), index('oauthClientResource_resourceId_idx').on(t.resourceId)]
);

export type OAuthClientResource = typeof oauthClientResources.$inferSelect;
export type NewOAuthClientResource = typeof oauthClientResources.$inferInsert;
