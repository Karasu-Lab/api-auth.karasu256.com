import { z } from 'zod';
import * as schema from '../../db/schema';
import { RedisRepository } from './redis-repository';

const minecraftLinkStatusSchema = z.object({ linked: z.boolean() });

export type MinecraftLinkStatus = z.output<typeof minecraftLinkStatusSchema>;

abstract class MinecraftLinkStatusRepository extends RedisRepository {
  protected readonly prefix = 'mc-auth';

  protected key(uuid: string): string {
    return `${this.prefix}:${uuid}`;
  }
}

export class MinecraftLinkStatusGetRepository extends MinecraftLinkStatusRepository {
  async get(uuid: string): Promise<MinecraftLinkStatus | null> {
    const value = await this.redis.get<string>(this.key(uuid));
    return value === null ? null : minecraftLinkStatusSchema.parse(JSON.parse(value));
  }
}

export class MinecraftLinkStatusSetRepository extends MinecraftLinkStatusRepository {
  async set(uuid: string, status: MinecraftLinkStatus): Promise<void> {
    await this.redis.set(this.key(uuid), JSON.stringify(status));
  }
}

const minecraftAccountRowSchema = z.object({ providerId: z.string(), accountId: z.string() });

export class MinecraftLinkStatusDeleteRepository extends MinecraftLinkStatusRepository {
  async delete(uuid: string): Promise<void> {
    await this.redis.del(this.key(uuid));
  }

  static async invalidate(env: Env, table: unknown, rows: unknown[]): Promise<void> {
    if (table !== schema.accounts) return;
    const repository = new MinecraftLinkStatusDeleteRepository(env);
    const uuids = rows.flatMap((row) => {
      const parsed = minecraftAccountRowSchema.safeParse(row);
      return parsed.success && parsed.data.providerId === 'minecraft' ? [parsed.data.accountId] : [];
    });
    await Promise.all(uuids.map((uuid) => repository.delete(uuid)));
  }
}
