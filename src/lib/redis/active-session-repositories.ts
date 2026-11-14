import { z } from 'zod';
import { RedisRepository } from './redis-repository';

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
}
