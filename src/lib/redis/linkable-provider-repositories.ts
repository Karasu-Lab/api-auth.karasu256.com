import { z } from 'zod';
import { RedisRepository } from './redis-repository';

const providerClientSchema = z.object({
  providerId: z.string(),
  clientId: z.string().nullable(),
  iconPath: z.string(),
});

const providerClientsSchema = z.array(providerClientSchema);

export type LinkableProviderClient = z.output<typeof providerClientSchema>;

abstract class LinkableProviderRepository extends RedisRepository {
  protected readonly prefix = 'linkable-providers';

  protected get key(): string {
    return `${this.prefix}:clients`;
  }
}

export class LinkableProviderGetRepository extends LinkableProviderRepository {
  async get(): Promise<LinkableProviderClient[] | null> {
    const value = await this.redis.get<string>(this.key);
    return value === null ? null : providerClientsSchema.parse(JSON.parse(value));
  }
}

export class LinkableProviderSetRepository extends LinkableProviderRepository {
  async set(clients: LinkableProviderClient[]): Promise<void> {
    await this.redis.set(this.key, JSON.stringify(clients));
  }
}
