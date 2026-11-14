import type { SecondaryStorage } from 'better-auth';
import Redis from 'ioredis';

export function createRedis(env: Env): Redis | null {
  if (!env.REDIS_URL) return null;
  return new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
}

export async function closeRedis(redis: Redis | null): Promise<void> {
  if (!redis) return;
  await redis.quit().catch(() => redis.disconnect());
}

export function redisSecondaryStorage(redis: Redis): SecondaryStorage {
  return {
    get: (key) => redis.get(key),
    getAndDelete: (key) => redis.getdel(key),
    increment: async (key, ttl) => {
      const [[, value]] = (await redis.multi().incr(key).expire(key, ttl).exec()) as [[Error | null, number]];
      return value;
    },
    set: async (key, value, ttl) => {
      if (ttl) await redis.set(key, value, 'EX', ttl);
      else await redis.set(key, value);
    },
    delete: async (key) => {
      await redis.del(key);
    },
  };
}
