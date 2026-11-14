import { waitUntil } from 'cloudflare:workers';
import { createDb } from '@karasu-lab/db/create-db';
import { createAuth, type Auth } from './auth';

export async function withAuth<T>(env: Env, fn: (auth: Auth) => Promise<T>): Promise<T> {
  const db = createDb(env.HYPERDRIVE.connectionString);
  try {
    return await fn(createAuth(env, db));
  } finally {
    waitUntil(db.$client.end());
  }
}
