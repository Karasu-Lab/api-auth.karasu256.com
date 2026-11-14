import { and, asc, count, eq, inArray, lte, sql } from 'drizzle-orm';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { createDb, type Db } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import { getAuthConfig } from '../config';
import { deleteFirebaseUser } from './firebase';
import { ensureFirebaseLink } from './firebase-link';
import { syncUserToNeonAuth } from './neon-auth';

const STALE_SYNCING_MS = 15 * 60 * 1000;

type BatchWorkContexts = {
  'firebase.link-user': { userId: string };
  'firebase.delete-user': { firebaseUid: string };
  'neon-auth.sync-user': { id: string; email: string | null; name: string | null };
};

export type BatchWorkType = keyof BatchWorkContexts;

const handlers: { [K in BatchWorkType]: (env: Env, db: Db, context: BatchWorkContexts[K]) => Promise<void> } = {
  'firebase.link-user': (env, db, { userId }) => ensureFirebaseLink(env, db, userId),
  'firebase.delete-user': (env, _db, { firebaseUid }) => deleteFirebaseUser(env, firebaseUid),
  'neon-auth.sync-user': (env, _db, user) => syncUserToNeonAuth(env, user),
};

function isBatchWorkType(type: string): type is BatchWorkType {
  return Object.hasOwn(handlers, type);
}

export async function enqueueBatchWork<K extends BatchWorkType>(env: Env, db: Db, type: K, context: BatchWorkContexts[K]): Promise<void> {
  await db.insert(schema.batchWorks).values({
    id: crypto.randomUUID(),
    type,
    context: await symmetricEncrypt({ key: env.BETTER_AUTH_SECRET, data: JSON.stringify(context) }),
  });
}

async function encryptError(env: Env, error: unknown): Promise<string> {
  const detail = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  return symmetricEncrypt({ key: env.BETTER_AUTH_SECRET, data: detail });
}

async function failStaleBatchWorks(env: Env, db: Db): Promise<void> {
  await db
    .update(schema.batchWorks)
    .set({ status: 'error', error: await encryptError(env, 'Timed out while syncing'), finishedAt: new Date() })
    .where(and(eq(schema.batchWorks.status, 'syncing'), lte(schema.batchWorks.startedAt, new Date(Date.now() - STALE_SYNCING_MS))));
}

async function claimBatchWorks(db: Db, maxConcurrency: number): Promise<schema.BatchWork[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('batch_works'))`);
    const [{ syncing }] = await tx.select({ syncing: count() }).from(schema.batchWorks).where(eq(schema.batchWorks.status, 'syncing'));
    const limit = maxConcurrency - syncing;
    if (limit <= 0) return [];

    const pending = tx
      .select({ id: schema.batchWorks.id })
      .from(schema.batchWorks)
      .where(and(eq(schema.batchWorks.status, 'pending'), lte(schema.batchWorks.scheduledAt, new Date())))
      .orderBy(asc(schema.batchWorks.scheduledAt))
      .limit(limit);

    return tx
      .update(schema.batchWorks)
      .set({ status: 'syncing', startedAt: new Date() })
      .where(inArray(schema.batchWorks.id, pending))
      .returning();
  });
}

async function runBatchWork(env: Env, db: Db, work: schema.BatchWork): Promise<void> {
  try {
    if (!isBatchWorkType(work.type)) throw new Error(`Unknown batch work type: ${work.type}`);
    const context = JSON.parse(await symmetricDecrypt({ key: env.BETTER_AUTH_SECRET, data: work.context }));
    await (handlers[work.type] as (env: Env, db: Db, context: unknown) => Promise<void>)(env, db, context);
    await db.update(schema.batchWorks).set({ status: 'completed', finishedAt: new Date() }).where(eq(schema.batchWorks.id, work.id));
  } catch (error) {
    console.error(`Batch work ${work.id} (${work.type}) failed`, error);
    await db
      .update(schema.batchWorks)
      .set({ status: 'error', error: await encryptError(env, error), finishedAt: new Date() })
      .where(eq(schema.batchWorks.id, work.id));
  }
}

export async function runBatchWorks(env: Env): Promise<void> {
  const db = createDb(env.HYPERDRIVE.connectionString);
  try {
    await failStaleBatchWorks(env, db);
    const { maxConcurrency } = getAuthConfig(env).batchWorks;
    for (let works = await claimBatchWorks(db, maxConcurrency); works.length > 0; works = await claimBatchWorks(db, maxConcurrency)) {
      await Promise.all(works.map((work) => runBatchWork(env, db, work)));
    }
  } finally {
    await db.$client.end();
  }
}
