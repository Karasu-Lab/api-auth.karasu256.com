import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { z } from 'zod';
import type { Db } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import { AccountLinkDeleteRepository } from './redis/account-link-repositories';
import { ActiveSessionDeleteRepository } from './redis/active-session-repositories';
import { AuthorizedAppDeleteRepository } from './redis/authorized-app-repositories';
import {
  OAuthClientCreateRepository,
  OAuthClientDeleteRepository,
  OAuthClientGetRepository,
  OAuthClientUpdateRepository,
} from './redis/oauth-client-repositories';

const clientSchema = z.object({ clientId: z.string(), clientSecret: z.string().nullish() });
const userRowSchema = z.object({ userId: z.string().nullish() });

type Where = { field: string; value: unknown; operator?: string }[];

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
  const authorizedAppDeleteRepository = new AuthorizedAppDeleteRepository(env);
  const activeSessionDeleteRepository = new ActiveSessionDeleteRepository(env);
  const accountLinkDeleteRepository = new AccountLinkDeleteRepository(env);
  const isOAuthClient = (model: string) => tables[model] === schema.oauthClients;
  const isOAuthConsent = (model: string) => tables[model] === schema.oauthConsents;
  const isSession = (model: string) => tables[model] === schema.sessions;
  const isAccount = (model: string) => tables[model] === schema.accounts;
  const tracksUsers = (model: string) => isOAuthConsent(model) || isSession(model) || isAccount(model);
  const clientIdOf = (model: string, where: Where) => {
    if (!isOAuthClient(model) || where.length !== 1) return null;
    const [condition] = where;
    if (condition.field !== 'clientId' || (condition.operator && condition.operator !== 'eq')) return null;
    return typeof condition.value === 'string' ? condition.value : null;
  };

  return (options) => {
    const adapter = factory(options);

    const storeClient = async (client: unknown, store: (clientId: string, client: unknown) => Promise<void>) => {
      const { clientId, clientSecret } = clientSchema.parse(client);
      if (clientSecret) await deleteRepository.delete(clientId);
      else await store(clientId, client);
    };

    const forgetUsers = async (rows: unknown[], forget: (userId: string) => Promise<void>) => {
      const userIds = new Set(rows.map((row) => userRowSchema.parse(row).userId).filter((userId) => userId != null));
      await Promise.all([...userIds].map(forget));
    };

    const consentModel = Object.keys(tables).find(isOAuthConsent);
    const findConsents = (clientId: string) =>
      consentModel ? adapter.findMany({ model: consentModel, where: [{ field: 'clientId', value: clientId }] }) : Promise.resolve([]);
    const forgetConsentingUsers = async (consents: unknown[]) =>
      forgetUsers(consents, (userId) => authorizedAppDeleteRepository.delete(userId));

    const forgetChangedRows = async (model: string, rows: unknown[]) => {
      if (isOAuthConsent(model)) await forgetUsers(rows, (userId) => authorizedAppDeleteRepository.delete(userId));
      if (isSession(model)) await forgetUsers(rows, (userId) => activeSessionDeleteRepository.delete(userId));
      if (isAccount(model)) await forgetUsers(rows, (userId) => accountLinkDeleteRepository.delete(userId));
    };

    return {
      ...adapter,
      findOne: async <T>(data: Parameters<typeof adapter.findOne>[0]) => {
        const clientId = data.select || data.join ? null : clientIdOf(data.model, data.where);
        if (!clientId) return adapter.findOne<T>(data);
        const cached = await getRepository.get<T>(clientId);
        if (cached) return cached;
        const client = await adapter.findOne<T>(data);
        if (client) await storeClient(client, (id, value) => createRepository.create(id, value));
        return client;
      },
      create: async <T extends Record<string, unknown>, R = T>(data: Parameters<typeof adapter.create<T, R>>[0]) => {
        const created = await adapter.create<T, R>(data);
        if (isOAuthClient(data.model)) await storeClient(created, (id, value) => createRepository.create(id, value));
        await forgetChangedRows(data.model, [created]);
        return created;
      },
      update: async <T>(data: Parameters<typeof adapter.update>[0]) => {
        const updated = await adapter.update<T>(data);
        if (updated && isOAuthClient(data.model)) {
          await storeClient(updated, (id, value) => updateRepository.update(id, value));
          await forgetConsentingUsers(await findConsents(clientSchema.parse(updated).clientId));
        }
        if (updated) await forgetChangedRows(data.model, [updated]);
        return updated;
      },
      incrementOne: async <T>(data: Parameters<typeof adapter.incrementOne>[0]) => {
        const updated = await adapter.incrementOne<T>(data);
        if (updated && isOAuthClient(data.model)) await storeClient(updated, (id, value) => updateRepository.update(id, value));
        return updated;
      },
      delete: async <T>(data: Parameters<typeof adapter.delete>[0]) => {
        const clientId = clientIdOf(data.model, data.where);
        const consents = clientId ? await findConsents(clientId) : [];
        const rows = tracksUsers(data.model) ? await adapter.findMany(data) : [];
        await adapter.delete<T>(data);
        if (clientId) await deleteRepository.delete(clientId);
        await forgetConsentingUsers(consents);
        await forgetChangedRows(data.model, rows);
      },
      deleteMany: async (data: Parameters<typeof adapter.deleteMany>[0]) => {
        const rows = tracksUsers(data.model) ? await adapter.findMany(data) : [];
        const deleted = await adapter.deleteMany(data);
        await forgetChangedRows(data.model, rows);
        return deleted;
      },
    };
  };
}
