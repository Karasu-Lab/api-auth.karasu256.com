import { boolean, integer, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { users } from './users';

/** better-auth's `passkey` model (see the `@better-auth/passkey` plugin's schema docs). */
export const passkeys = pgTable('passkey', {
  id: text('id').primaryKey(),
  name: varchar('name', { length: 255 }),
  publicKey: text('public_key').notNull(),
  userId: varchar('user_id', { length: 128 })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  credentialID: text('credential_id').notNull(),
  counter: integer('counter').notNull(),
  deviceType: varchar('device_type', { length: 32 }).notNull(),
  backedUp: boolean('backed_up').notNull(),
  transports: text('transports'),
  createdAt: timestamp('created_at').defaultNow(),
  aaguid: text('aaguid'),
});

export type Passkey = typeof passkeys.$inferSelect;
export type NewPasskey = typeof passkeys.$inferInsert;
