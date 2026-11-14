import { RedisRepository } from './redis-repository';

export class SessionSourceGetRepository extends RedisRepository {
  protected readonly prefix = 'session-source:';

  get(sessionId: string): Promise<string | null> {
    return this.redis.get<string>(`${this.prefix}${sessionId}`);
  }
}

export class SessionSourceCreateRepository extends RedisRepository {
  protected readonly prefix = 'session-source:';

  async create(sessionId: string, source: string, expiresAt: Date): Promise<void> {
    const ttl = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
    if (ttl > 0) await this.redis.set(`${this.prefix}${sessionId}`, source, { ex: ttl });
  }
}
