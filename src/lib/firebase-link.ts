import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/create-db';
import * as schema from '../db/schema';
import { createFirebaseUser, findFirebaseUidByEmail, updateFirebaseUser, type FirebaseProviderUserInfo } from './firebase';

export async function getLinkedFirebaseUid(db: Db, userId: string): Promise<string | null> {
  const [link] = await db
    .select({ firebaseUid: schema.firebaseUsers.firebaseUid })
    .from(schema.firebaseUsers)
    .where(eq(schema.firebaseUsers.userId, userId))
    .limit(1);
  return link?.firebaseUid ?? null;
}

async function getGoogleProviderUserInfo(db: Db, userId: string): Promise<FirebaseProviderUserInfo[] | undefined> {
  const [google] = await db
    .select({ accountId: schema.accounts.accountId })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.userId, userId), eq(schema.accounts.providerId, 'google')))
    .limit(1);
  return google ? [{ providerId: 'google.com', rawId: google.accountId }] : undefined;
}

export async function ensureFirebaseLink(env: Env, db: Db, userId: string): Promise<void> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user) return;

  await db.insert(schema.firebaseUsers).values({ userId }).onConflictDoNothing();

  const providerUserInfo = await getGoogleProviderUserInfo(db, userId);
  const profile = {
    displayName: user.name ?? undefined,
    photoURL: user.image ?? undefined,
  };

  const linkedUid = await getLinkedFirebaseUid(db, userId);
  if (linkedUid) {
    if (user.name || user.image || providerUserInfo) {
      await updateFirebaseUser(env, linkedUid, { ...profile, providerUserInfo });
    }
    return;
  }

  if (user.email) {
    const existingUid = await findFirebaseUidByEmail(env, user.email);
    if (existingUid) {
      await updateFirebaseUser(env, existingUid, { ...profile, providerUserInfo });
      await db.update(schema.firebaseUsers).set({ firebaseUid: existingUid, updatedAt: new Date() }).where(eq(schema.firebaseUsers.userId, userId));
      return;
    }
  }

  const firebaseUid = await createFirebaseUser(env, {
    ...(user.email ? { email: user.email, emailVerified: user.emailVerified } : {}),
    displayName: user.name ?? undefined,
    ...(providerUserInfo ? { providerUserInfo } : {}),
  });

  await db.update(schema.firebaseUsers).set({ firebaseUid, updatedAt: new Date() }).where(eq(schema.firebaseUsers.userId, userId));
}
