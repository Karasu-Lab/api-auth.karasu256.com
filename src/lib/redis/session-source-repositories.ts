import { SessionRedisRepository } from './redis-repository';

export class SessionSourceGetRepository extends SessionRedisRepository {
  protected readonly prefix = 'session-source';

  get(): Promise<string | null> {
    return this.redis.get<string>(this.key);
  }
}

export class SessionSourceCreateRepository extends SessionRedisRepository {
  protected readonly prefix = 'session-source';

  async create(source: string): Promise<void> {
    await this.store(this.key, source);
  }
}

export class SessionSourceDeleteRepository extends SessionRedisRepository {
  protected readonly prefix = 'session-source';

  async delete(): Promise<void> {
    await this.redis.del(this.key);
  }
}
