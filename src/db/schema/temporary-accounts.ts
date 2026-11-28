import { index, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { temporaryUsers } from './temporary-users';

export const temporaryAccounts = pgTable(
  'temporary_accounts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: varchar('user_id', { length: 128 })
      .notNull()
      .references(() => temporaryUsers.id, { onDelete: 'cascade' }),
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
  (t) => [index('temporary_account_userId_idx').on(t.userId)]
);

export type TemporaryAccount = typeof temporaryAccounts.$inferSelect;
export type NewTemporaryAccount = typeof temporaryAccounts.$inferInsert;
