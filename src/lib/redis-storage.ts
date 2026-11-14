import type { SecondaryStorage } from 'better-auth';
import { Redis } from '@upstash/redis/cloudflare';

export function createRedis(env: Env): Redis | null {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return null;
  return new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
    automaticDeserialization: false,
  });
}

export function redisSecondaryStorage(redis: Redis): SecondaryStorage {
  const isVerification = (key: string) => key.startsWith('verification:');
  return {
    get: async (key) => (isVerification(key) ? null : await redis.get<string>(key)),
    getAndDelete: async (key) => (isVerification(key) ? null : await redis.getdel<string>(key)),
    increment: async (key, ttl) => {
      const value = await redis.incr(key);
      await redis.expire(key, ttl);
      return value;
    },
    set: async (key, value, ttl) => {
      if (isVerification(key)) return;
      if (ttl) await redis.set(key, value, { ex: ttl });
      else await redis.set(key, value);
    },
    delete: async (key) => {
      if (isVerification(key)) return;
      await redis.del(key);
    },
  };
}
