import { Redis } from '@upstash/redis/cloudflare';

export abstract class RedisRepository {
  protected abstract readonly prefix: string;
  protected readonly redis: Redis;

  constructor(env: Env) {
    this.redis = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
      automaticDeserialization: false,
    });
  }

  async close(): Promise<void> {}
}
