import { boolean, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

/**
 * Also serves as better-auth's `user` model (mapped via `drizzleAdapter`'s
 * `schema` option in `apps/accounts/src/lib/auth/server.ts`) so every table
 * that references a person — sessions, OAuth tokens, everything — points at
 * the same row. Ids are better-auth's own; the link to Firebase Auth lives
 * in the separate `firebase_user` table so sign-in never depends on it.
 * `email`/`image` stay nullable because pre-existing rows don't have them
 * backfilled.
 */
export const users = pgTable('users', {
  id: varchar('id', { length: 128 }).primaryKey(),
  name: varchar('name', { length: 255 }),
  email: varchar('email', { length: 255 }).unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: varchar('image', { length: 2048 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
