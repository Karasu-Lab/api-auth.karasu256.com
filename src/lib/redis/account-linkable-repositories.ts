import { z } from 'zod';
import * as schema from '../../db/schema';
import { RedisRepository } from './redis-repository';

abstract class AccountLinkableRepository extends RedisRepository {
  protected readonly prefix = 'account-linkable';

  protected key(userId: string, providerId: string, providerUserId: string): string {
    return `${this.prefix}:${userId}:${providerId}:${providerUserId}`;
  }
}

export class AccountLinkableGetRepository extends AccountLinkableRepository {
  async get(userId: string, providerId: string, providerUserId: string): Promise<boolean | null> {
    const value = await this.redis.get<string>(this.key(userId, providerId, providerUserId));
    return value === null ? null : value === 'true';
  }
}

export class AccountLinkableSetRepository extends AccountLinkableRepository {
  async set(userId: string, providerId: string, providerUserId: string, linkable: boolean): Promise<void> {
    await this.store(this.key(userId, providerId, providerUserId), linkable ? 'true' : 'false');
  }
}

const accountRowSchema = z.object({ userId: z.string(), providerId: z.string(), accountId: z.string() });

export class AccountLinkableDeleteRepository extends AccountLinkableRepository {
  async delete(userId: string, providerId: string, providerUserId: string): Promise<void> {
    await this.redis.del(this.key(userId, providerId, providerUserId));
  }

  static async invalidate(env: Env, table: unknown, rows: unknown[]): Promise<void> {
    if (table !== schema.accounts) return;
    const repository = new AccountLinkableDeleteRepository(env);
    const targets = rows.flatMap((row) => {
      const parsed = accountRowSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
    await Promise.all(targets.map((target) => repository.delete(target.userId, target.providerId, target.accountId)));
  }
}
