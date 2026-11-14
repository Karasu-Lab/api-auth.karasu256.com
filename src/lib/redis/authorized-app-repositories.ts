import { z } from 'zod';
import * as schema from '@karasu-lab/db/schema';
import { RedisRepository } from './redis-repository';
import { userIdsOf, type FindRows } from './rows';

const clientRowSchema = z.object({ clientId: z.string() });

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

  async invalidate(table: unknown, rows: unknown[], find: FindRows): Promise<void> {
    if (table === schema.oauthConsents) {
      await Promise.all(userIdsOf(rows).map((userId) => this.delete(userId)));
    } else if (table === schema.oauthClients) {
      const consents = await Promise.all(
        rows.map((row) => find(schema.oauthConsents, [{ field: 'clientId', value: clientRowSchema.parse(row).clientId }]))
      );
      await Promise.all(userIdsOf(consents.flat()).map((userId) => this.delete(userId)));
    }
  }
}
