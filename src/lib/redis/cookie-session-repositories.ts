import { RedisRepository } from './redis-repository';

export class CookieSessionGetRepository extends RedisRepository {
  protected readonly prefix = 'cookie-session';

  get(cookieHash: string): Promise<string | null> {
    return this.redis.get<string>(`${this.prefix}-${cookieHash}`);
  }
}

export class CookieSessionCreateRepository extends RedisRepository {
  protected readonly prefix = 'cookie-session';
  protected override readonly ttl = 60;

  async create(cookieHash: string, value: string): Promise<void> {
    await this.store(`${this.prefix}-${cookieHash}`, value);
  }
}
