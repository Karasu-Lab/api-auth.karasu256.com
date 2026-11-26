import { Redis } from '@upstash/redis/cloudflare';
import { log } from '@karasu-lab/utils/server/log';

interface SetOptions {
  ex?: number;
  nx?: boolean;
  xx?: boolean;
}

const PING_TIMEOUT_MS = 1000;
const RECHECK_INTERVAL_MS = 30_000;

let availability: { enabled: boolean; checkedAt: number } | null = null;

function createRedis(env: Env): Redis {
  return new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN, automaticDeserialization: false });
}

function markRedisAvailability(enabled: boolean) {
  availability = { enabled, checkedAt: Date.now() };
}

export async function isRedisEnabled(env: Env): Promise<boolean> {
  if (env.APP_ENV === 'preview') return false;
  if (availability && Date.now() - availability.checkedAt < RECHECK_INTERVAL_MS) return availability.enabled;

  const enabled = await Promise.race([
    createRedis(env)
      .ping()
      .then(
        () => true,
        () => false
      ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PING_TIMEOUT_MS)),
  ]);
  if (!enabled) log('redis_unavailable', { reason: 'ping_failed_or_timed_out' }, 'error');
  markRedisAvailability(enabled);
  return enabled;
}

export class CacheClient {
  private client: Redis | null = null;

  constructor(private readonly env: Env) {}

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
    if (!(await isRedisEnabled(this.env))) return fallback;
    try {
      return await operation((this.client ??= createRedis(this.env)));
    } catch (error) {
      log('redis_unavailable', { message: error instanceof Error ? error.message : String(error) }, 'error');
      markRedisAvailability(false);
      return fallback;
    }
  }
}
