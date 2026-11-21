import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Creates a new Drizzle client with the given connection URL, which comes from a binding
 * (e.g. Cloudflare Hyperdrive) or an environment variable.
 */
export function createDb(url: string): Db {
  const sql = postgres(url, { max: 1 });
  return drizzle(sql, { schema });
}
