import { waitUntil } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { createDb } from '../db/create-db';
import * as schema from '../db/schema';
import {
  MinecraftLinkStatusGetRepository,
  MinecraftLinkStatusSetRepository,
  type MinecraftLinkStatus,
} from './redis/minecraft-link-status-repositories';

export function normalizeMinecraftUuid(uuid: string): string {
  return uuid.replaceAll('-', '').toLowerCase();
}

export async function getMinecraftLinkStatus(env: Env, uuid: string): Promise<MinecraftLinkStatus> {
  const normalized = normalizeMinecraftUuid(uuid);
  const cached = await new MinecraftLinkStatusGetRepository(env).get(normalized);
  if (cached) return cached;

  const db = createDb(env.DATABASE_URL);
  let linked: boolean;
  try {
    const [account] = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.providerId, 'minecraft'), eq(schema.accounts.accountId, normalized)))
      .limit(1);
    linked = Boolean(account);
  } finally {
    waitUntil(db.$client.end());
  }
  const status = { linked };
  await new MinecraftLinkStatusSetRepository(env).set(normalized, status);
  return status;
}
