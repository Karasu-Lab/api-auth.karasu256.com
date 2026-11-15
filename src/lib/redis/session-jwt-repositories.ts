import { SessionRedisRepository } from './redis-repository';

export class SessionJwtGetRepository extends SessionRedisRepository {
  protected readonly prefix = 'session-jwt';

  get(): Promise<string | null> {
    return this.redis.get<string>(this.key);
  }
}

export class SessionJwtCreateRepository extends SessionRedisRepository {
  protected readonly prefix = 'session-jwt';

  async create(token: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(this.key, token, { ex: ttlSeconds });
  }
}

export class SessionJwtDeleteRepository extends SessionRedisRepository {
  protected readonly prefix = 'session-jwt';

  async delete(): Promise<void> {
    await this.redis.del(this.key);
  }
}
