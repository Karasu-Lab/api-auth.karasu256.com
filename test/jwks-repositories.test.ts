import { describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

vi.mock('@upstash/redis/cloudflare', () => ({
  Redis: class {
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

const { JwksCreateRepository, JwksGetRepository } = await import('../src/lib/redis/jwks-repositories');

const env = { UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'token' } as Env;

describe('jwks cache', () => {
  it('does not keep serving an empty key list after the keys were cleaned up', async () => {
    store.clear();
    await new JwksCreateRepository(env).create([]);
    expect(await new JwksGetRepository(env).get()).toBeNull();
  });
});
