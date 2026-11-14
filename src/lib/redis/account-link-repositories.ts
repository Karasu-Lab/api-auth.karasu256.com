import { z } from 'zod';
import { RedisRepository } from './redis-repository';

export const accountLinkSchema = z.object({
  providerId: z.string(),
  id: z.string().nullable(),
  url: z.string().nullable(),
  linked: z.boolean(),
});

export type AccountLink = z.output<typeof accountLinkSchema>;

export class AccountLinkGetRepository extends RedisRepository {
  protected readonly prefix = 'account-links:';

  async get(userId: string): Promise<AccountLink[] | null> {
    const value = await this.redis.get<string>(`${this.prefix}${userId}`);
    return value === null ? null : z.array(accountLinkSchema).parse(JSON.parse(value));
  }
}

export class AccountLinkCreateRepository extends RedisRepository {
  protected readonly prefix = 'account-links:';

  async create(userId: string, links: AccountLink[]): Promise<void> {
    await this.redis.set(`${this.prefix}${userId}`, JSON.stringify(links));
  }
}

export class AccountLinkUpdateRepository extends RedisRepository {
  protected readonly prefix = 'account-links:';

  async update(userId: string, links: AccountLink[]): Promise<void> {
    await this.redis.set(`${this.prefix}${userId}`, JSON.stringify(links), { xx: true });
  }
}

export class AccountLinkDeleteRepository extends RedisRepository {
  protected readonly prefix = 'account-links:';

  async delete(userId: string): Promise<void> {
    await this.redis.del(`${this.prefix}${userId}`);
  }
}
