import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** better-auth's `jwt` plugin key storage, used to sign OAuth/OIDC access and ID tokens. */
export const jwks = pgTable('jwks', {
  id: text('id').primaryKey(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  alg: text('alg'),
  crv: text('crv'),
  createdAt: timestamp('created_at').notNull(),
  expiresAt: timestamp('expires_at'),
});

export type Jwk = typeof jwks.$inferSelect;
export type NewJwk = typeof jwks.$inferInsert;
