import { z } from 'zod';
import * as schema from '@karasu-lab/db/schema';
import { RedisRepository } from './redis-repository';
import { userIdsOf } from './rows';

export const activeSessionSchema = z.object({
  id: z.string(),
  source: z.string(),
  createdAt: z.string(),
});

export type ActiveSession = z.output<typeof activeSessionSchema>;

export class ActiveSessionGetRepository extends RedisRepository {
  protected readonly prefix = 'active-sessions:';

  async get(userId: string): Promise<ActiveSession[] | null> {
    const value = await this.redis.get<string>(`${this.prefix}${userId}`);
    return value === null ? null : z.array(activeSessionSchema).parse(JSON.parse(value));
  }
}

export class ActiveSessionCreateRepository extends RedisRepository {
  protected readonly prefix = 'active-sessions:';

  async create(userId: string, sessions: ActiveSession[]): Promise<void> {
    await this.redis.set(`${this.prefix}${userId}`, JSON.stringify(sessions));
  }
}

export class ActiveSessionDeleteRepository extends RedisRepository {
  protected readonly prefix = 'active-sessions:';

  async delete(userId: string): Promise<void> {
    await this.redis.del(`${this.prefix}${userId}`);
  }

  async invalidate(table: unknown, rows: unknown[]): Promise<void> {
    if (table === schema.sessions) await Promise.all(userIdsOf(rows).map((userId) => this.delete(userId)));
  }
}
