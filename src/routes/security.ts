import { waitUntil } from 'cloudflare:workers';
import { and, asc, eq } from 'drizzle-orm';
import { createDb } from '../db/create-db';
import * as schema from '../db/schema';
import {
  SecuritySettingCreateRepository,
  SecuritySettingGetRepository,
  type SecuritySettings,
} from '../lib/redis/security-setting-repositories';
import type { RedisSession } from '../lib/redis/redis-repository';
import { withAuth } from '../lib/request-auth';

async function loadSecuritySettings(env: Env, session: RedisSession): Promise<SecuritySettings> {
  const userId = session.userId;
  const cached = await new SecuritySettingGetRepository(env, session).get();
  if (cached) return cached;
  const db = createDb(env.DATABASE_URL);
  try {
    const [credential] = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.userId, userId), eq(schema.accounts.providerId, 'credential')))
      .limit(1);
    const passkeys = await db
      .select({ id: schema.passkeys.id, name: schema.passkeys.name, createdAt: schema.passkeys.createdAt })
      .from(schema.passkeys)
      .where(eq(schema.passkeys.userId, userId))
      .orderBy(asc(schema.passkeys.createdAt));
    const settings = {
      hasPassword: Boolean(credential),
      passkeys: passkeys.map((passkey) => ({ id: passkey.id, name: passkey.name, createdAt: passkey.createdAt?.toISOString() ?? null })),
    };
    await new SecuritySettingCreateRepository(env, session).create(settings);
    return settings;
  } finally {
    waitUntil(db.$client.end());
  }
}

export async function handleSecuritySettings(env: Env, request: Request): Promise<Response> {
  return withAuth(env, async (auth) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    return Response.json(await loadSecuritySettings(env, { id: session.session.id, userId: session.user.id, expiresAt: session.session.expiresAt }));
  });
}
