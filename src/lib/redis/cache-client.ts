import { Redis } from '@upstash/redis/cloudflare';
import { log } from '@karasu-lab/utils/server/log';

interface SetOptions {
  ex?: number;
  nx?: boolean;
  xx?: boolean;
}

export class CacheClient {
  private readonly redis: Redis | null;

  constructor(env: Env) {
    this.redis =
      env.APP_ENV === 'preview'
        ? null
        : new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN, automaticDeserialization: false });
  }

  get<T>(key: string): Promise<T | null> {
    return this.run((redis) => redis.get<T>(key), null);
  }

  set(key: string, value: string, options?: SetOptions): Promise<string | null> {
    return this.run((redis) => redis.set(key, value, options) as Promise<string | null>, 'OK');
  }

  del(...keys: string[]): Promise<number> {
    return this.run((redis) => redis.del(...keys), 0);
  }

  private async run<T>(operation: (redis: Redis) => Promise<T>, fallback: T): Promise<T> {
    if (!this.redis) return fallback;
    try {
      return await operation(this.redis);
    } catch (error) {
      log('redis_unavailable', { message: error instanceof Error ? error.message : String(error) }, 'error');
      return fallback;
    }
  }
}
