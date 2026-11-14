import { z } from 'zod';
import * as schema from '@karasu-lab/db/schema';
import { RedisRepository } from './redis-repository';
import { userIdsOf } from './rows';

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

  async invalidate(table: unknown, rows: unknown[]): Promise<void> {
    if (table === schema.accounts) await Promise.all(userIdsOf(rows).map((userId) => this.delete(userId)));
  }
}
