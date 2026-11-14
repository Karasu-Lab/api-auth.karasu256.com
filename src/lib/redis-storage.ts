import type { SecondaryStorage } from 'better-auth';
import { createRedis as createRedisClient } from 'redis-on-workers';

export type RedisClient = ReturnType<typeof createRedisClient>;

export function createRedis(env: Env): RedisClient | null {
  if (!env.REDIS_URL) return null;
  return createRedisClient(env.REDIS_URL);
}

export async function closeRedis(redis: RedisClient | null): Promise<void> {
  if (!redis) return;
  await redis.close();
}

export function redisSecondaryStorage(redis: RedisClient): SecondaryStorage {
  return {
    get: async (key) => (await redis.send('GET', key)) as string | null,
    getAndDelete: async (key) => (await redis.send('GETDEL', key)) as string | null,
    increment: async (key, ttl) => {
      const value = (await redis.send('INCR', key)) as number;
      await redis.send('EXPIRE', key, String(ttl));
      return value;
    },
    set: async (key, value, ttl) => {
      if (ttl) await redis.send('SET', key, value, 'EX', String(ttl));
      else await redis.send('SET', key, value);
    },
    delete: async (key) => {
      await redis.send('DEL', key);
    },
  };
}
