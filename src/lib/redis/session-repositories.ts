import { RedisRepository } from './redis-repository';

export class SessionGetRepository extends RedisRepository {
  protected readonly prefix = 'session';

  get(key: string): Promise<string | null> {
    return this.redis.get<string>(`${this.prefix}-${key}`);
  }
}

export class SessionCreateRepository extends RedisRepository {
  protected readonly prefix = 'session';

  async create(key: string, value: string, ttl?: number): Promise<boolean> {
    if (!ttl) return this.store(`${this.prefix}-${key}`, value, 'nx');
    return (await this.redis.set(`${this.prefix}-${key}`, value, { ex: ttl, nx: true })) !== null;
  }
}

export class SessionUpdateRepository extends RedisRepository {
  protected readonly prefix = 'session';

  async update(key: string, value: string, ttl?: number): Promise<void> {
    if (!ttl) await this.store(`${this.prefix}-${key}`, value, 'xx');
    else await this.redis.set(`${this.prefix}-${key}`, value, { ex: ttl, xx: true });
  }
}

export class SessionDeleteRepository extends RedisRepository {
  protected readonly prefix = 'session';

  async delete(key: string): Promise<void> {
    await this.redis.del(`${this.prefix}-${key}`);
  }
}
