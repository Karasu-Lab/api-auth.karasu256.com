import { members, sessions } from '@karasu-lab/db/schema';
import type { Db } from '@karasu-lab/db/create-db';
import { and, eq } from 'drizzle-orm';
import { HttpError } from '@karasu-lab/types/server';
import type { Auth } from './auth';

export const TENANT_SETUP_ROLES = ['owner', 'admin'] as const;

export async function resolveSessionUserId(db: Db, auth: Auth, sessionId: string): Promise<string | null> {
  const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  const session = rows[0];
  if (!session || session.expiresAt.getTime() <= Date.now()) return null;
  const found = await auth.$context
    .then((ctx) => ctx.internalAdapter.findSession(session.token))
    .catch(() => null);
  if (!found || found.session.id !== session.id) return null;
  if (found.session.expiresAt.getTime() <= Date.now()) return null;
  return found.user.id;
}

export async function getTenantRole(db: Db, userId: string, organizationId: string): Promise<string | null> {
  const rows = await db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.organizationId, organizationId)))
    .limit(1);
  return rows[0]?.role ?? null;
}

export async function requireTenantRole(
  db: Db,
  userId: string,
  organizationId: string,
  allowed: readonly string[]
): Promise<string> {
  const role = await getTenantRole(db, userId, organizationId);
  if (!role || !allowed.includes(role)) throw new HttpError(403, { error: 'Forbidden' });
  return role;
}
