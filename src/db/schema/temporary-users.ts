import { boolean, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

export const temporaryUsers = pgTable('temporary_users', {
  id: varchar('id', { length: 128 }).primaryKey(),
  name: varchar('name', { length: 255 }),
  email: varchar('email', { length: 255 }).unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: varchar('image', { length: 2048 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type TemporaryUser = typeof temporaryUsers.$inferSelect;
export type NewTemporaryUser = typeof temporaryUsers.$inferInsert;
