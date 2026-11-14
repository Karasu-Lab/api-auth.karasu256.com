import { and, asc, count, eq, inArray, lte, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { createDb, type Db } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import { getAuthConfig } from '../../config';
import { batchWorkStatusSchema, type BatchWork } from './batch-work';
import { FirebaseDeleteUserWork } from './firebase-delete-user';
import { FirebaseLinkUserWork } from './firebase-link-user';
import { NeonAuthSyncUserWork } from './neon-auth-sync-user';

export { FirebaseDeleteUserWork, FirebaseLinkUserWork, NeonAuthSyncUserWork };

const batchWorkClasses = [FirebaseLinkUserWork, FirebaseDeleteUserWork, NeonAuthSyncUserWork];

function createBatchWork(env: Env, db: Db, type: string): BatchWork<z.ZodType> | null {
  for (const Work of batchWorkClasses) {
    const work: BatchWork<z.ZodType> = new Work(env, db);
    if (work.type === type) return work;
  }
  return null;
}

async function claimBatchWorks(db: Db, maxConcurrency: number): Promise<{ id: string; type: string }[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('batch_works'))`);
    const [{ syncing }] = await tx.select({ syncing: count() }).from(schema.batchWorks).where(eq(schema.batchWorks.status, batchWorkStatusSchema.enum.syncing));
    const limit = maxConcurrency - syncing;
    if (limit <= 0) return [];

    const pending = tx
      .select({ id: schema.batchWorks.id })
      .from(schema.batchWorks)
      .where(and(eq(schema.batchWorks.status, batchWorkStatusSchema.enum.pending), lte(schema.batchWorks.scheduledAt, new Date())))
      .orderBy(asc(schema.batchWorks.scheduledAt))
      .limit(limit);

    return tx
      .update(schema.batchWorks)
      .set({ status: batchWorkStatusSchema.enum.syncing, startedAt: new Date() })
      .where(inArray(schema.batchWorks.id, pending))
      .returning({ id: schema.batchWorks.id, type: schema.batchWorks.type });
  });
}

async function runClaimedBatchWork(env: Env, db: Db, { id, type }: { id: string; type: string }): Promise<void> {
  const work = createBatchWork(env, db, type);
  if (!work) return;
  work.id = id;
  await work.read();
  await work.run();
}

export async function runBatchWorks(env: Env): Promise<void> {
  const db = createDb(env.HYPERDRIVE.connectionString);
  try {
    await Promise.all(batchWorkClasses.map((Work) => new Work(env, db).failStale()));
    const { maxConcurrency } = getAuthConfig(env).batchWorks;
    for (let works = await claimBatchWorks(db, maxConcurrency); works.length > 0; works = await claimBatchWorks(db, maxConcurrency)) {
      await Promise.all(works.map((work) => runClaimedBatchWork(env, db, work)));
    }
  } finally {
    await db.$client.end();
  }
}
