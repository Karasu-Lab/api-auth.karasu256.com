import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import type { Db } from '@karasu-lab/db/create-db';
import { AccountLinkDeleteRepository } from './redis/account-link-repositories';
import { ActiveSessionDeleteRepository } from './redis/active-session-repositories';
import { AuthorizedAppDeleteRepository } from './redis/authorized-app-repositories';
import {
  OAuthClientCreateRepository,
  OAuthClientDeleteRepository,
  OAuthClientGetRepository,
  OAuthClientUpdateRepository,
} from './redis/oauth-client-repositories';
import type { FindRows } from './redis/rows';
import { SecuritySettingDeleteRepository } from './redis/security-setting-repositories';

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
  const invalidators = [
    new AuthorizedAppDeleteRepository(env),
    new ActiveSessionDeleteRepository(env),
    new AccountLinkDeleteRepository(env),
    new SecuritySettingDeleteRepository(env),
  ];

  return (options) => {
    const adapter = factory(options);
    const find: FindRows = async (table, where) => {
      const model = Object.keys(tables).find((key) => tables[key] === table);
      return model ? adapter.findMany({ model, where }) : [];
    };
    const invalidate = (model: string, rows: unknown[]) =>
      Promise.all(invalidators.map((repository) => repository.invalidate(tables[model], rows, find)));

    return {
      ...adapter,
      findOne: async <T>(data: Parameters<typeof adapter.findOne>[0]) => {
        if (data.select || data.join) return adapter.findOne<T>(data);
        const cached = await getRepository.get<T>(tables[data.model], data.where);
        if (cached) return cached;
        const row = await adapter.findOne<T>(data);
        if (row) await createRepository.create(tables[data.model], row);
        return row;
      },
      create: async <T extends Record<string, unknown>, R = T>(data: Parameters<typeof adapter.create<T, R>>[0]) => {
        const created = await adapter.create<T, R>(data);
        await createRepository.create(tables[data.model], created);
        await invalidate(data.model, [created]);
        return created;
      },
      update: async <T>(data: Parameters<typeof adapter.update>[0]) => {
        const updated = await adapter.update<T>(data);
        if (updated) {
          await updateRepository.update(tables[data.model], updated);
          await invalidate(data.model, [updated]);
        }
        return updated;
      },
      incrementOne: async <T>(data: Parameters<typeof adapter.incrementOne>[0]) => {
        const updated = await adapter.incrementOne<T>(data);
        if (updated) await updateRepository.update(tables[data.model], updated);
        return updated;
      },
      delete: async <T>(data: Parameters<typeof adapter.delete>[0]) => {
        await invalidate(data.model, await adapter.findMany(data));
        await adapter.delete<T>(data);
        await deleteRepository.delete(tables[data.model], data.where);
      },
      deleteMany: async (data: Parameters<typeof adapter.deleteMany>[0]) => {
        await invalidate(data.model, await adapter.findMany(data));
        return adapter.deleteMany(data);
      },
    };
  };
}
