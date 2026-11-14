import type { Where as WhereClause } from 'better-auth';
import { z } from 'zod';

export type Where = WhereClause[];

export type FindRows = (table: unknown, where: Where) => Promise<unknown[]>;

const userRowSchema = z.object({ userId: z.string() });

export function userIdsOf(rows: unknown[]): string[] {
  return [...new Set(rows.flatMap((row) => {
    const parsed = userRowSchema.safeParse(row);
    return parsed.success ? [parsed.data.userId] : [];
  }))];
}
