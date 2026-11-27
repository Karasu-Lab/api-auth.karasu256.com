import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/create-db';
import * as schema from '../db/schema';
import { createFirebaseUser, findFirebaseUidByEmail, updateFirebaseUser } from './firebase';

export async function getLinkedFirebaseUid(db: Db, userId: string): Promise<string | null> {
  const [link] = await db
    .select({ firebaseUid: schema.firebaseUsers.firebaseUid })
    .from(schema.firebaseUsers)
    .where(eq(schema.firebaseUsers.userId, userId))
    .limit(1);
  return link?.firebaseUid ?? null;
}

export async function ensureFirebaseLink(env: Env, db: Db, userId: string): Promise<void> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user) return;

  await db.insert(schema.firebaseUsers).values({ userId }).onConflictDoNothing();

  const linkedUid = await getLinkedFirebaseUid(db, userId);
  if (linkedUid) {
    if (user.name || user.image) {
      await updateFirebaseUser(env, linkedUid, {
        displayName: user.name ?? undefined,
        photoURL: user.image ?? undefined,
      });
    }
    return;
  }

  const firebaseUid = user.email
    ? (await findFirebaseUidByEmail(env, user.email)) ??
      (await createFirebaseUser(env, {
        email: user.email,
        emailVerified: user.emailVerified,
        displayName: user.name ?? undefined,
      }))
    : await createFirebaseUserWithoutEmail(env, db, user);

  await db.update(schema.firebaseUsers).set({ firebaseUid, updatedAt: new Date() }).where(eq(schema.firebaseUsers.userId, userId));
}

async function createFirebaseUserWithoutEmail(
  env: Env,
  db: Db,
  user: { id: string; name: string | null },
): Promise<string> {
  const [google] = await db
    .select({ accountId: schema.accounts.accountId })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.userId, user.id), eq(schema.accounts.providerId, 'google')))
    .limit(1);
  return createFirebaseUser(env, {
    displayName: user.name ?? undefined,
    ...(google ? { providerUserInfo: [{ providerId: 'google.com', rawId: google.accountId }] } : {}),
  });
}
