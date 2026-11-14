import { RedisRepository } from './redis-repository';

export class CookieSessionGetRepository extends RedisRepository {
  protected readonly prefix = 'cookie-session:';

  get(cookieHash: string): Promise<string | null> {
    return this.redis.get<string>(`${this.prefix}${cookieHash}`);
  }
}

export class CookieSessionCreateRepository extends RedisRepository {
  protected readonly prefix = 'cookie-session:';

  async create(cookieHash: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(`${this.prefix}${cookieHash}`, value, { ex: ttlSeconds });
  }
}
