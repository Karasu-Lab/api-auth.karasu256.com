import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * better-auth's `emailChallenge` model for the `better-auth-email-challenge`
 * plugin: one row per sign-in attempt, holding the hashed one-time code until
 * it is verified, locked out, or expires.
 */
export const emailChallenges = pgTable(
  'email_challenge',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    hashedApprovalToken: text('hashed_approval_token').notNull().unique(),
    hashedOtp: text('hashed_otp').notNull(),
    browserBindingHash: text('browser_binding_hash').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    name: text('name'),
    callbackURL: text('callback_url'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    expiresAt: timestamp('expires_at').notNull(),
    approvedAt: timestamp('approved_at'),
    consumedAt: timestamp('consumed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index('emailChallenge_email_idx').on(t.email)]
);
