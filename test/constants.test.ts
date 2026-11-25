import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { resolveEnv } from '../src/constants';

function rawEnv(overrides: Record<string, string | undefined>): Env {
  return {
    BETTER_AUTH_URL: 'https://dev-api-auth.karasu256.com',
    AUTH_UI_URL: 'https://dev-auth.karasu256.com',
    SSO_UI_URL: 'https://dev-sso.karasu256.com',
    ACCOUNTS_URL: 'https://dev-accounts.karasu256.com',
    MCP_URL: 'https://dev-mcp.karasu256.com/mcp',
    API_URL: 'https://dev-api.karasu256.com',
    MC_AUTH_URL: 'https://dev-mc-auth.karasu256.com',
    UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
    UPSTASH_REDIS_REST_TOKEN: 'token',
    HYPERDRIVE: { connectionString: 'postgres://example.test/db' },
    ...overrides,
  } as unknown as Env;
}

describe('resolveEnv', () => {
  it('names BASE_DOMAIN when the session cookie domain is missing outside local', () => {
    const error = (() => {
      try {
        resolveEnv(rawEnv({ APP_ENV: 'preview' }));
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(ZodError);
    expect((error as ZodError).issues.map((issue) => issue.path.join('.'))).toEqual(['BASE_DOMAIN']);
  });

  it('accepts the environment when BASE_DOMAIN is set', () => {
    expect(resolveEnv(rawEnv({ APP_ENV: 'preview', BASE_DOMAIN: 'karasu256.com' })).BASE_DOMAIN).toBe('karasu256.com');
  });

  it('does not require BASE_DOMAIN locally', () => {
    expect(() => resolveEnv(rawEnv({ APP_ENV: 'local' }))).not.toThrow();
  });
});
