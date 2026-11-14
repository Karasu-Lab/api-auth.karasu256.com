import { z } from 'zod';
import * as schema from '@karasu-lab/db/schema';
import { RedisRepository } from './redis-repository';
import { userIdsOf } from './rows';

export const securitySettingsSchema = z.object({
  hasPassword: z.boolean(),
  passkeys: z.array(z.object({ id: z.string(), name: z.string().nullable(), createdAt: z.string().nullable() })),
});

export type SecuritySettings = z.output<typeof securitySettingsSchema>;

export class SecuritySettingGetRepository extends RedisRepository {
  protected readonly prefix = 'security-settings:';

  async get(userId: string): Promise<SecuritySettings | null> {
    const value = await this.redis.get<string>(`${this.prefix}${userId}`);
    return value === null ? null : securitySettingsSchema.parse(JSON.parse(value));
  }
}

export class SecuritySettingCreateRepository extends RedisRepository {
  protected readonly prefix = 'security-settings:';

  async create(userId: string, settings: SecuritySettings): Promise<void> {
    await this.redis.set(`${this.prefix}${userId}`, JSON.stringify(settings));
  }
}

export class SecuritySettingDeleteRepository extends RedisRepository {
  protected readonly prefix = 'security-settings:';

  async delete(userId: string): Promise<void> {
    await this.redis.del(`${this.prefix}${userId}`);
  }

  async invalidate(table: unknown, rows: unknown[]): Promise<void> {
    if (table === schema.accounts || table === schema.passkeys) {
      await Promise.all(userIdsOf(rows).map((userId) => this.delete(userId)));
    }
  }
}
