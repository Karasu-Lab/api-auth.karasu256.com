import { RedisRepository } from './redis-repository';

export class XRequestTokenCreateRepository extends RedisRepository {
  protected readonly prefix = 'x-request-token';
  protected override readonly ttl = 10 * 60;

  async create(requestToken: string, requestTokenSecret: string): Promise<void> {
    await this.store(`${this.prefix}-${requestToken}`, requestTokenSecret);
  }
}

export class XRequestTokenTakeRepository extends RedisRepository {
  protected readonly prefix = 'x-request-token';

  async take(requestToken: string): Promise<string | null> {
    const key = `${this.prefix}-${requestToken}`;
    const secret = await this.redis.get<string>(key);
    if (secret === null) return null;
    await this.redis.del(key);
    return secret;
  }
}
