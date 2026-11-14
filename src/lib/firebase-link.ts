import { eq } from 'drizzle-orm';
import type { Db } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import { createFirebaseUser, findFirebaseUidByEmail, updateFirebaseUser } from './firebase';

/**
 * Returns the Firebase UID linked to a better-auth user, or null when the
 * user has no `firebase_user` row yet or the row is still unlinked.
 */
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

  if (!user.email) return;

  const firebaseUid =
    (await findFirebaseUidByEmail(env, user.email)) ??
    (await createFirebaseUser(env, {
      email: user.email,
      emailVerified: user.emailVerified,
      displayName: user.name ?? undefined,
    }));

  await db.update(schema.firebaseUsers).set({ firebaseUid, updatedAt: new Date() }).where(eq(schema.firebaseUsers.userId, userId));
}
