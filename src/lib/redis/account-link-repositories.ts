import { z } from 'zod';
import * as schema from '../../db/schema';
import { SessionRedisRepository } from './redis-repository';
import { sessionsOfUsers, userIdsOf, type FindRows } from './rows';

export const accountLinkSchema = z.object({
  providerId: z.string(),
  id: z.string().nullable(),
  url: z.string().nullable(),
  linked: z.boolean(),
});

export type AccountLink = z.output<typeof accountLinkSchema>;

export class AccountLinkGetRepository extends SessionRedisRepository {
  protected readonly prefix = 'account-links';

  async get(): Promise<AccountLink[] | null> {
    const value = await this.redis.get<string>(this.key);
    return value === null ? null : z.array(accountLinkSchema).parse(JSON.parse(value));
  }
}

export class AccountLinkCreateRepository extends SessionRedisRepository {
  protected readonly prefix = 'account-links';

  async create(links: AccountLink[]): Promise<void> {
    await this.store(this.key, links);
  }
}

export class AccountLinkUpdateRepository extends SessionRedisRepository {
  protected readonly prefix = 'account-links';

  async update(links: AccountLink[]): Promise<void> {
    await this.store(this.key, links, 'xx');
  }
}

export class AccountLinkDeleteRepository extends SessionRedisRepository {
  protected readonly prefix = 'account-links';

  async delete(): Promise<void> {
    await this.redis.del(this.key);
  }

  static async invalidate(env: Env, table: unknown, rows: unknown[], find: FindRows): Promise<void> {
    if (table !== schema.accounts) return;
    const sessions = await sessionsOfUsers(userIdsOf(rows), find);
    await Promise.all(sessions.map((session) => new AccountLinkDeleteRepository(env, session).delete()));
  }
}
