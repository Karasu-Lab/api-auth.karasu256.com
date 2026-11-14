import { RedisRepository } from './redis-repository';

export class SessionExpiryGetRepository extends RedisRepository {
  protected readonly prefix = 'session-expiry:';

  async get(sessionId: string): Promise<number | null> {
    const value = await this.redis.get<string>(`${this.prefix}${sessionId}`);
    return value === null ? null : Number(value);
  }
}

export class SessionExpiryCreateRepository extends RedisRepository {
  protected readonly prefix = 'session-expiry:';

  async create(sessionId: string, expiresAt: Date): Promise<void> {
    const remaining = Math.max(Math.floor((expiresAt.getTime() - Date.now()) / 1000), 0);
    await this.redis.set(`${this.prefix}${sessionId}`, String(expiresAt.getTime()), { ex: remaining + 3600 });
  }
}

export class SessionExpiryRevokeRepository extends RedisRepository {
  protected readonly prefix = 'session-expiry:';

  async revoke(sessionId: string): Promise<void> {
    await this.redis.set(`${this.prefix}${sessionId}`, '0', { ex: 3600 });
  }
}
