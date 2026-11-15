import { secondsUntil, SessionRedisRepository } from './redis-repository';

export class SessionJwtGetRepository extends SessionRedisRepository {
  protected readonly prefix = 'session-jwt';

  get(): Promise<string | null> {
    return this.redis.get<string>(this.key);
  }
}

export class SessionJwtCreateRepository extends SessionRedisRepository {
  protected readonly prefix = 'session-jwt';
  protected override readonly ttl = Math.min(10 * 60, secondsUntil(this.session.expiresAt));

  async create(token: string): Promise<void> {
    await this.store(this.key, token);
  }
}

export class SessionJwtDeleteRepository extends SessionRedisRepository {
  protected readonly prefix = 'session-jwt';

  async delete(): Promise<void> {
    await this.redis.del(this.key);
  }
}
