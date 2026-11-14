import { waitUntil } from 'cloudflare:workers';
import { createDb } from '@karasu-lab/db/create-db';
import { createAuth, type Auth } from './auth';
import { closeRedis, createRedis } from './redis-storage';

export async function withAuth<T>(env: Env, fn: (auth: Auth) => Promise<T>): Promise<T> {
  const db = createDb(env.HYPERDRIVE.connectionString);
  const redis = createRedis(env);
  try {
    return await fn(createAuth(env, db, redis));
  } finally {
    waitUntil(db.$client.end());
    waitUntil(closeRedis(redis));
  }
}
