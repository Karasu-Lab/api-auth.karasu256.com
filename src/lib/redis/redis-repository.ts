import { CacheClient } from './cache-client';

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
  protected readonly redis: CacheClient;

  constructor(
    env: Env,
    protected readonly session: RedisSession | null = null
  ) {
    this.redis = new CacheClient(env);
  }

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
  declare protected readonly session: RedisSession;
  protected override readonly ttl: number;

  constructor(env: Env, session: RedisSession) {
    super(env, session);
    this.ttl = secondsUntil(session.expiresAt);
  }

  protected get key(): string {
    return `${this.prefix}-${this.session.id}-${this.session.userId}`;
  }
}
