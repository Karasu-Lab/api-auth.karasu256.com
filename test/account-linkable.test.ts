import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

vi.mock('@upstash/redis/cloudflare', () => ({
  Redis: class {
    async ping() {
      return 'PONG';
    }
    async get(key: string) {
      return store.get(key) ?? null;
    }
    async set(key: string, value: string) {
      store.set(key, value);
      return 'OK';
    }
    async del(key: string) {
      store.delete(key);
    }
  },
}));

vi.mock('cloudflare:workers', () => ({ waitUntil: () => undefined }));

const database = vi.hoisted(() => ({ owner: null as { userId: string } | null, calls: 0 }));

vi.mock('../src/db/create-db', () => ({
  createDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            database.calls += 1;
            return database.owner ? [database.owner] : [];
          },
        }),
      }),
    }),
    $client: { end: async () => undefined },
  }),
}));

const { getAccountLinkable } = await import('../src/lib/account-linkable');
const { AccountLinkableGetRepository, AccountLinkableSetRepository } = await import('../src/lib/redis/account-linkable-repositories');

const env = {
  UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  DATABASE_URL: 'postgres://unused',
} as Env;

const KEY = 'account-linkable:user-1:github:provider-user-1';

describe('account linkable repositories', () => {
  beforeEach(() => {
    store.clear();
  });

  it('stores only a boolean under the user, provider and provider user key', async () => {
    await new AccountLinkableSetRepository(env).set('user-1', 'github', 'provider-user-1', true);
    expect(store.get(KEY)).toBe('true');
    expect(await new AccountLinkableGetRepository(env).get('user-1', 'github', 'provider-user-1')).toBe(true);

    await new AccountLinkableSetRepository(env).set('user-1', 'github', 'provider-user-1', false);
    expect(store.get(KEY)).toBe('false');
    expect(await new AccountLinkableGetRepository(env).get('user-1', 'github', 'provider-user-1')).toBe(false);
  });

  it('returns null when nothing is cached', async () => {
    expect(await new AccountLinkableGetRepository(env).get('user-1', 'github', 'provider-user-1')).toBeNull();
  });
});

describe('getAccountLinkable', () => {
  beforeEach(() => {
    store.clear();
    database.owner = null;
    database.calls = 0;
  });

  it('reads Redis first and does not touch the database on a cache hit', async () => {
    store.set(KEY, 'false');
    database.owner = { userId: 'user-1' };

    expect(await getAccountLinkable(env, 'user-1', 'github', 'provider-user-1')).toBe(false);
    expect(database.calls).toBe(0);
  });

  it('falls back to the database and caches the result when Redis has no entry', async () => {
    database.owner = { userId: 'another-user' };

    expect(await getAccountLinkable(env, 'user-1', 'github', 'provider-user-1')).toBe(false);
    expect(database.calls).toBe(1);
    expect(store.get(KEY)).toBe('false');

    expect(await getAccountLinkable(env, 'user-1', 'github', 'provider-user-1')).toBe(false);
    expect(database.calls).toBe(1);
  });

  it('is linkable when the provider account belongs to the user', async () => {
    database.owner = { userId: 'user-1' };

    expect(await getAccountLinkable(env, 'user-1', 'github', 'provider-user-1')).toBe(true);
    expect(store.get(KEY)).toBe('true');
  });

  it('is linkable when the provider account is not linked to anyone', async () => {
    database.owner = null;

    expect(await getAccountLinkable(env, 'user-1', 'github', 'provider-user-1')).toBe(true);
    expect(store.get(KEY)).toBe('true');
  });
});
