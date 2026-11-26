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

const { readJwks } = await import('../src/lib/redis/jwks-repositories');

const env = { UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'token' } as Env;

const databaseKey = { id: 'key-1', publicKey: '{}', privateKey: 'private', createdAt: new Date('2026-11-25T00:00:00Z'), alg: 'RS256' };

describe('readJwks', () => {
  beforeEach(() => {
    store.clear();
  });

  it('reads the database when nothing is cached and caches the keys it finds', async () => {
    const readFromDatabase = vi.fn(async () => [databaseKey]);
    expect(await readJwks(env, readFromDatabase)).toHaveLength(1);
    expect(readFromDatabase).toHaveBeenCalledTimes(1);

    await readJwks(env, readFromDatabase);
    expect(readFromDatabase).toHaveBeenCalledTimes(1);
  });

  it('reads the database again when the cached list is empty', async () => {
    store.set('jwks-keys', '[]');
    const readFromDatabase = vi.fn(async () => [databaseKey]);
    expect(await readJwks(env, readFromDatabase)).toHaveLength(1);
    expect(readFromDatabase).toHaveBeenCalledTimes(1);
  });

  it('does not cache an empty database result', async () => {
    const readFromDatabase = vi.fn(async () => []);
    expect(await readJwks(env, readFromDatabase)).toEqual([]);
    expect(store.has('jwks-keys')).toBe(false);
  });
});
