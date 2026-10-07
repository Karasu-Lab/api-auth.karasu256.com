import { waitUntil } from 'cloudflare:workers';
import { createDb } from '@Hashibutogarasu/db/create-db';
import { createAuth, type Auth } from './auth';

/**
 * Runs `fn` with a better-auth instance bound to a database connection that
 * lives only for this request. The connection is closed after the response
 * is returned, through `waitUntil`, so it never outlives the request that
 * opened it.
 */
export async function withAuth<T>(env: Env, fn: (auth: Auth) => Promise<T>): Promise<T> {
  const db = createDb(env.DATABASE_URL);
  try {
    return await fn(createAuth(env, db));
  } finally {
    waitUntil(db.$client.end());
  }
}
