import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { z } from 'zod';
import type { Db } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import {
  OAuthClientCreateRepository,
  OAuthClientDeleteRepository,
  OAuthClientGetRepository,
  OAuthClientUpdateRepository,
} from './redis/oauth-client-repositories';

const clientSchema = z.object({ clientId: z.string() });

export function oauthClientRedisAdapter(
  env: Env,
  db: Db,
  config: Parameters<typeof drizzleAdapter>[1] & { schema: Record<string, unknown> }
): ReturnType<typeof drizzleAdapter> {
  const factory = drizzleAdapter(db, config);
  const tables = config.schema;
  const getRepository = new OAuthClientGetRepository(env);
  const createRepository = new OAuthClientCreateRepository(env);
  const updateRepository = new OAuthClientUpdateRepository(env);
  const deleteRepository = new OAuthClientDeleteRepository(env);
  const isOAuthClient = (model: string) => tables[model] === schema.oauthClients;
  const clientIdOf = (model: string, where: { field: string; value: unknown; operator?: string }[]) => {
    if (!isOAuthClient(model) || where.length !== 1) return null;
    const [condition] = where;
    if (condition.field !== 'clientId' || (condition.operator && condition.operator !== 'eq')) return null;
    return typeof condition.value === 'string' ? condition.value : null;
  };

  return (options) => {
    const adapter = factory(options);
    return {
      ...adapter,
      findOne: async <T>(data: Parameters<typeof adapter.findOne>[0]) => {
        const clientId = data.select || data.join ? null : clientIdOf(data.model, data.where);
        if (!clientId) return adapter.findOne<T>(data);
        const cached = await getRepository.get<T>(clientId);
        if (cached) return cached;
        const client = await adapter.findOne<T>(data);
        if (client) await createRepository.create(clientId, client);
        return client;
      },
      create: async <T extends Record<string, unknown>, R = T>(data: Parameters<typeof adapter.create<T, R>>[0]) => {
        const created = await adapter.create<T, R>(data);
        if (isOAuthClient(data.model)) await createRepository.create(clientSchema.parse(created).clientId, created);
        return created;
      },
      update: async <T>(data: Parameters<typeof adapter.update>[0]) => {
        const updated = await adapter.update<T>(data);
        if (isOAuthClient(data.model) && updated) await updateRepository.update(clientSchema.parse(updated).clientId, updated);
        return updated;
      },
      incrementOne: async <T>(data: Parameters<typeof adapter.incrementOne>[0]) => {
        const updated = await adapter.incrementOne<T>(data);
        if (isOAuthClient(data.model) && updated) await updateRepository.update(clientSchema.parse(updated).clientId, updated);
        return updated;
      },
      delete: async <T>(data: Parameters<typeof adapter.delete>[0]) => {
        await adapter.delete<T>(data);
        const clientId = clientIdOf(data.model, data.where);
        if (clientId) await deleteRepository.delete(clientId);
      },
    };
  };
}
