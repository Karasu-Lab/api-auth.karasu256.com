import { waitUntil } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { createDb } from '../db/create-db';
import * as schema from '../db/schema';
import { AccountLinkableGetRepository, AccountLinkableSetRepository } from './redis/account-linkable-repositories';

export async function getAccountLinkable(env: Env, userId: string, providerId: string, providerUserId: string): Promise<boolean> {
  const cached = await new AccountLinkableGetRepository(env).get(userId, providerId, providerUserId);
  if (cached !== null) return cached;

  const db = createDb(env.DATABASE_URL);
  let linkable: boolean;
  try {
    const [owner] = await db
      .select({ userId: schema.accounts.userId })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.providerId, providerId), eq(schema.accounts.accountId, providerUserId)))
      .limit(1);
    linkable = !owner || owner.userId === userId;
  } finally {
    waitUntil(db.$client.end());
  }
  await new AccountLinkableSetRepository(env).set(userId, providerId, providerUserId, linkable);
  return linkable;
}
