import { z } from 'zod';
import { RedisRepository } from './redis-repository';

export const authorizedAppSchema = z.object({
  clientId: z.string(),
  permissions: z.number().int(),
  icon: z.string().nullable(),
  name: z.string().nullable(),
});

export type AuthorizedApp = z.output<typeof authorizedAppSchema>;

export class AuthorizedAppGetRepository extends RedisRepository {
  protected readonly prefix = 'authorized-apps:';

  async get(userId: string): Promise<AuthorizedApp[] | null> {
    const value = await this.redis.get<string>(`${this.prefix}${userId}`);
    return value === null ? null : z.array(authorizedAppSchema).parse(JSON.parse(value));
  }
}

export class AuthorizedAppCreateRepository extends RedisRepository {
  protected readonly prefix = 'authorized-apps:';

  async create(userId: string, apps: AuthorizedApp[]): Promise<void> {
    await this.redis.set(`${this.prefix}${userId}`, JSON.stringify(apps));
  }
}

export class AuthorizedAppDeleteRepository extends RedisRepository {
  protected readonly prefix = 'authorized-apps:';

  async delete(userId: string): Promise<void> {
    await this.redis.del(`${this.prefix}${userId}`);
  }
}
