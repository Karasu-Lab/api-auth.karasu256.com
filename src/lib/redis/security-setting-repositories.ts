import { z } from 'zod';
import * as schema from '../../db/schema';
import { SessionRedisRepository } from './redis-repository';
import { sessionsOfUsers, userIdsOf, type FindRows } from './rows';

export const securitySettingsSchema = z.object({
  hasPassword: z.boolean(),
  passkeys: z.array(z.object({ id: z.string(), name: z.string().nullable(), createdAt: z.string().nullable() })),
});

export type SecuritySettings = z.output<typeof securitySettingsSchema>;

export class SecuritySettingGetRepository extends SessionRedisRepository {
  protected readonly prefix = 'security-settings';

  async get(): Promise<SecuritySettings | null> {
    const value = await this.redis.get<string>(this.key);
    return value === null ? null : securitySettingsSchema.parse(JSON.parse(value));
  }
}

export class SecuritySettingCreateRepository extends SessionRedisRepository {
  protected readonly prefix = 'security-settings';

  async create(settings: SecuritySettings): Promise<void> {
    await this.store(this.key, settings);
  }
}

export class SecuritySettingDeleteRepository extends SessionRedisRepository {
  protected readonly prefix = 'security-settings';

  async delete(): Promise<void> {
    await this.redis.del(this.key);
  }

  static async invalidate(env: Env, table: unknown, rows: unknown[], find: FindRows): Promise<void> {
    if (table !== schema.accounts && table !== schema.passkeys) return;
    const sessions = await sessionsOfUsers(userIdsOf(rows), find);
    await Promise.all(sessions.map((session) => new SecuritySettingDeleteRepository(env, session).delete()));
  }
}
