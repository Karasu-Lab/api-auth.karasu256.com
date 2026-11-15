import { Redis } from '@upstash/redis/cloudflare';

export interface RedisSession {
  id: string;
  userId: string;
  expiresAt: Date;
}

export function secondsUntil(date: Date): number {
  return Math.floor((date.getTime() - Date.now()) / 1000);
}

export abstract class RedisRepository {
  protected abstract readonly prefix: string;
  protected readonly ttl: number = 60 * 60;
  protected readonly redis: Redis;

  constructor(
    env: Env,
    protected readonly session: RedisSession | null = null
  ) {
    this.redis = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
      automaticDeserialization: false,
    });
  }

  /** Stores the value for `ttl` seconds, serializing non-strings as JSON. Skips the write and returns false when `ttl` has run out. */
  protected async store(key: string, value: unknown, condition?: 'nx' | 'xx'): Promise<boolean> {
    if (this.ttl <= 0) return false;
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    const result = await this.redis.set(
      key,
      serialized,
      condition === 'nx' ? { ex: this.ttl, nx: true } : condition === 'xx' ? { ex: this.ttl, xx: true } : { ex: this.ttl }
    );
    return result !== null;
  }

  async close(): Promise<void> {}
}

export abstract class SessionRedisRepository extends RedisRepository {
  protected declare readonly session: RedisSession;
  protected override readonly ttl: number;

  constructor(env: Env, session: RedisSession) {
    super(env, session);
    this.ttl = secondsUntil(session.expiresAt);
  }

  protected get key(): string {
    return `${this.prefix}-${this.session.id}-${this.session.userId}`;
  }
}
