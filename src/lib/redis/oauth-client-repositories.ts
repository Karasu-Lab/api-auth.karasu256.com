import { z } from 'zod';
import * as schema from '@karasu-lab/db/schema';
import { RedisRepository } from './redis-repository';
import type { Where } from './rows';

const clientSchema = z.object({ clientId: z.string(), clientSecret: z.string().nullish() });

const clientIdWhereSchema = z.tuple([z.object({ field: z.literal('clientId'), value: z.string(), operator: z.literal('eq').optional() })]);

function clientIdOf(where: Where): string | null {
  const parsed = clientIdWhereSchema.safeParse(where);
  return parsed.success ? parsed.data[0].value : null;
}

export class OAuthClientGetRepository extends RedisRepository {
  protected readonly prefix = 'oauth-client:';

  async get<T>(table: unknown, where: Where): Promise<T | null> {
    const clientId = table === schema.oauthClients ? clientIdOf(where) : null;
    if (!clientId) return null;
    const value = await this.redis.get<string>(`${this.prefix}${clientId}`);
    if (value === null) return null;
    return JSON.parse(value, (_key, field) => {
      const date = z.iso.datetime().safeParse(field);
      return date.success ? new Date(date.data) : field;
    });
  }
}

export class OAuthClientCreateRepository extends RedisRepository {
  protected readonly prefix = 'oauth-client:';

  async create(table: unknown, row: unknown): Promise<void> {
    if (table !== schema.oauthClients) return;
    const { clientId, clientSecret } = clientSchema.parse(row);
    if (clientSecret) return;
    await this.redis.set(`${this.prefix}${clientId}`, JSON.stringify(row));
  }
}

export class OAuthClientUpdateRepository extends RedisRepository {
  protected readonly prefix = 'oauth-client:';

  async update(table: unknown, row: unknown): Promise<void> {
    if (table !== schema.oauthClients) return;
    const { clientId, clientSecret } = clientSchema.parse(row);
    if (clientSecret) await this.redis.del(`${this.prefix}${clientId}`);
    else await this.redis.set(`${this.prefix}${clientId}`, JSON.stringify(row), { xx: true });
  }
}

export class OAuthClientDeleteRepository extends RedisRepository {
  protected readonly prefix = 'oauth-client:';

  async delete(table: unknown, where: Where): Promise<void> {
    const clientId = table === schema.oauthClients ? clientIdOf(where) : null;
    if (clientId) await this.redis.del(`${this.prefix}${clientId}`);
  }
}
