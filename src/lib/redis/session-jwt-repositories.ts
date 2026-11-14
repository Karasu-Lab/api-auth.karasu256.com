import { RedisRepository } from './redis-repository';

export class SessionJwtGetRepository extends RedisRepository {
  protected readonly prefix = 'session-jwt:';

  get(sessionId: string): Promise<string | null> {
    return this.redis.get<string>(`${this.prefix}${sessionId}`);
  }
}

export class SessionJwtCreateRepository extends RedisRepository {
  protected readonly prefix = 'session-jwt:';

  async create(sessionId: string, token: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(`${this.prefix}${sessionId}`, token, { ex: ttlSeconds });
  }
}
