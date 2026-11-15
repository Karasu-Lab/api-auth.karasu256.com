import { SessionRedisRepository } from './redis-repository';

export class SessionSourceGetRepository extends SessionRedisRepository {
  protected readonly prefix = 'session-source';

  get(): Promise<string | null> {
    return this.redis.get<string>(this.key);
  }
}

export class SessionSourceCreateRepository extends SessionRedisRepository {
  protected readonly prefix = 'session-source';

  async create(source: string, expiresAt: Date): Promise<void> {
    const ttl = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
    if (ttl > 0) await this.redis.set(this.key, source, { ex: ttl });
  }
}

export class SessionSourceDeleteRepository extends SessionRedisRepository {
  protected readonly prefix = 'session-source';

  async delete(): Promise<void> {
    await this.redis.del(this.key);
  }
}
