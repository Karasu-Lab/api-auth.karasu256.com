import { index, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * better-auth's `account` model. Replaces `provider_accounts` + `provider_tokens` —
 * token fields live inline here. `accessToken`/`refreshToken`/`idToken` are
 * encrypted at rest via the `account.encryptOAuthTokens` option in
 * `apps/accounts/src/lib/auth/server.ts`, not by this schema.
 */
export const accounts = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: varchar('user_id', { length: 128 })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index('account_userId_idx').on(t.userId)]
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
