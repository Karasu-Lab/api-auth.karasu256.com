import { Redis } from '@upstash/redis/cloudflare';

export interface RedisSession {
  id: string;
  userId: string;
}

export abstract class RedisRepository {
  protected abstract readonly prefix: string;
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

  async close(): Promise<void> {}
}

export abstract class SessionRedisRepository extends RedisRepository {
  protected declare readonly session: RedisSession;

  constructor(env: Env, session: RedisSession) {
    super(env, session);
  }

  protected get key(): string {
    return `${this.prefix}-${this.session.id}-${this.session.userId}`;
  }
}
