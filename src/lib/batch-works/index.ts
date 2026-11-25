import { and, asc, count, eq, inArray, lte, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { createDb, type Db } from '../../db/create-db';
import * as schema from '../../db/schema';
import { getAuthConfig } from '../../config';
import { batchWorkStatusSchema, type BatchWork } from './batch-work';
import { FirebaseDeleteUserWork } from './firebase-delete-user';
import { FirebaseLinkUserWork } from './firebase-link-user';
import { RedisSessionCleanupWork } from './redis-session-cleanup';

export { FirebaseDeleteUserWork, FirebaseLinkUserWork, RedisSessionCleanupWork };

const batchWorkClasses = [FirebaseLinkUserWork, FirebaseDeleteUserWork, RedisSessionCleanupWork];

function createBatchWork(env: Env, db: Db, type: string): BatchWork<z.ZodType> | null {
  for (const Work of batchWorkClasses) {
    const work: BatchWork<z.ZodType> = new Work(env, db);
    if (work.type === type) return work;
  }
  return null;
}

async function claimBatchWorks(db: Db, maxConcurrency: number, types: string[]): Promise<{ id: string; type: string }[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('batch_works'))`);
    const [{ syncing }] = await tx
      .select({ syncing: count() })
      .from(schema.batchWorks)
      .where(and(eq(schema.batchWorks.status, batchWorkStatusSchema.enum.syncing), inArray(schema.batchWorks.type, types)));
    const limit = maxConcurrency - syncing;
    if (limit <= 0) return [];

    const pending = tx
      .select({ id: schema.batchWorks.id })
      .from(schema.batchWorks)
      .where(
        and(
          eq(schema.batchWorks.status, batchWorkStatusSchema.enum.pending),
          inArray(schema.batchWorks.type, types),
          lte(schema.batchWorks.scheduledAt, new Date())
        )
      )
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
    const types = batchWorkClasses.map((Work) => new Work(env, db).type);
    for (
      let works = await claimBatchWorks(db, maxConcurrency, types);
      works.length > 0;
      works = await claimBatchWorks(db, maxConcurrency, types)
    ) {
      await Promise.all(works.map((work) => runClaimedBatchWork(env, db, work)));
    }
  } finally {
    await db.$client.end();
  }
}
