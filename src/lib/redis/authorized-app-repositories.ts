import { z } from 'zod';
import * as schema from '../../db/schema';
import { SessionRedisRepository } from './redis-repository';
import { sessionsOfUsers, userIdsOf, type FindRows } from './rows';

export const authorizedAppSchema = z.object({
  clientId: z.string(),
  permissions: z.number().int(),
  icon: z.string().nullable(),
  name: z.string().nullable(),
});

export type AuthorizedApp = z.output<typeof authorizedAppSchema>;

export class AuthorizedAppGetRepository extends SessionRedisRepository {
  protected readonly prefix = 'authorized-apps';

  async get(): Promise<AuthorizedApp[] | null> {
    const value = await this.redis.get<string>(this.key);
    return value === null ? null : z.array(authorizedAppSchema).parse(JSON.parse(value));
  }
}

export class AuthorizedAppCreateRepository extends SessionRedisRepository {
  protected readonly prefix = 'authorized-apps';

  async create(apps: AuthorizedApp[]): Promise<void> {
    await this.store(this.key, apps);
  }
}

export class AuthorizedAppDeleteRepository extends SessionRedisRepository {
  protected readonly prefix = 'authorized-apps';

  async delete(): Promise<void> {
    await this.redis.del(this.key);
  }

  static async invalidate(env: Env, table: unknown, rows: unknown[], find: FindRows): Promise<void> {
    let userIds: string[] = [];
    if (table === schema.oauthConsents) {
      userIds = userIdsOf(rows);
    } else if (table === schema.oauthClients) {
      const consents = await Promise.all(
        rows.map((row) => find(schema.oauthConsents, [{ field: 'clientId', value: z.object({ clientId: z.string() }).parse(row).clientId }]))
      );
      userIds = userIdsOf(consents.flat());
    }
    const sessions = await sessionsOfUsers(userIds, find);
    await Promise.all(sessions.map((session) => new AuthorizedAppDeleteRepository(env, session).delete()));
  }
}
