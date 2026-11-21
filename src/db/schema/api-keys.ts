import { boolean, index, integer, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { users } from './users';

/** `@better-auth/api-key`'s standard `apikey` model. Its own `permissions` column is unused; grants live in `api_key_permissions`. */
export const apiKeys = pgTable(
  'apikey',
  {
    id: text('id').primaryKey(),
    configId: text('config_id').default('default').notNull(),
    name: text('name'),
    start: text('start'),
    referenceId: varchar('reference_id', { length: 128 })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    prefix: text('prefix'),
    key: text('key').notNull(),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: timestamp('last_refill_at'),
    enabled: boolean('enabled').default(true),
    rateLimitEnabled: boolean('rate_limit_enabled').default(true),
    rateLimitTimeWindow: integer('rate_limit_time_window'),
    rateLimitMax: integer('rate_limit_max'),
    requestCount: integer('request_count').default(0),
    remaining: integer('remaining'),
    lastRequest: timestamp('last_request'),
    expiresAt: timestamp('expires_at'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
    permissions: text('permissions'),
    metadata: text('metadata'),
  },
  (t) => [index('apikey_configId_idx').on(t.configId), index('apikey_referenceId_idx').on(t.referenceId), index('apikey_key_idx').on(t.key)]
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
