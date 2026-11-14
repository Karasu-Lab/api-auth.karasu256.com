import { RedisRepository } from './redis-repository';

export class OAuthClientGetRepository extends RedisRepository {
  protected readonly prefix = 'oauth-client:';

  async get<T>(clientId: string): Promise<T | null> {
    const value = await this.redis.get<string>(`${this.prefix}${clientId}`);
    if (value === null) return null;
    return JSON.parse(value, (_key, field) =>
      typeof field === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(field) ? new Date(field) : field
    );
  }
}

export class OAuthClientCreateRepository extends RedisRepository {
  protected readonly prefix = 'oauth-client:';

  async create(clientId: string, client: unknown): Promise<void> {
    await this.redis.set(`${this.prefix}${clientId}`, JSON.stringify(client));
  }
}

export class OAuthClientUpdateRepository extends RedisRepository {
  protected readonly prefix = 'oauth-client:';

  async update(clientId: string, client: unknown): Promise<void> {
    await this.redis.set(`${this.prefix}${clientId}`, JSON.stringify(client), { xx: true });
  }
}

export class OAuthClientDeleteRepository extends RedisRepository {
  protected readonly prefix = 'oauth-client:';

  async delete(clientId: string): Promise<void> {
    await this.redis.del(`${this.prefix}${clientId}`);
  }
}
