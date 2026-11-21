import { pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Loose link between a better-auth user and its Firebase Auth user.
 *
 * The database is the single source of truth for sign-in: a better-auth user
 * exists and can authenticate whether or not a Firebase user is linked.
 * `firebaseUid` stays null until the link is established (lazily, at sign-in)
 * and is updated in place when the Firebase side changes. No Firebase profile
 * data is mirrored here — Firebase remains the owner of that data; this table
 * only maps the two identities.
 */
export const firebaseUsers = pgTable('firebase_user', {
  userId: varchar('user_id', { length: 128 })
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  firebaseUid: varchar('firebase_uid', { length: 128 }).unique(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export type FirebaseUser = typeof firebaseUsers.$inferSelect;
export type NewFirebaseUser = typeof firebaseUsers.$inferInsert;
