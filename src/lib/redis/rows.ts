import type { Where as WhereClause } from 'better-auth';
import { z } from 'zod';
import * as schema from '@karasu-lab/db/schema';
import type { RedisSession } from './redis-repository';

export type Where = WhereClause[];

export type FindRows = (table: unknown, where: Where) => Promise<unknown[]>;

export interface RedisInvalidator {
  invalidate(table: unknown, rows: unknown[], find: FindRows): Promise<void>;
}

const sessionRowSchema = z.object({ id: z.string(), userId: z.string(), expiresAt: z.coerce.date() });

export async function sessionsOfUsers(userIds: string[], find: FindRows): Promise<RedisSession[]> {
  const rows = await Promise.all(userIds.map((userId) => find(schema.sessions, [{ field: 'userId', value: userId }])));
  return rows.flat().map((row) => sessionRowSchema.parse(row));
}

const userRowSchema = z.object({ userId: z.string() });

export function userIdsOf(rows: unknown[]): string[] {
  return [...new Set(rows.flatMap((row) => {
    const parsed = userRowSchema.safeParse(row);
    return parsed.success ? [parsed.data.userId] : [];
  }))];
}
