import { createHmac } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { genericOAuth } from 'better-auth/plugins';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { getMockOAuthProviders } from '../src/lib/mock-oauth';

const SECRET = 'oauth-entry-secret';
const BASE_URL = 'https://auth.test';
const MOCK_URL = 'https://mock-oauth.test';
const NATIVE_STATE = 'entry-state-0123456789abcdef';

const { entryEnv } = vi.hoisted(() => ({
  entryEnv: {
    APP_ENV: 'local',
    BETTER_AUTH_SECRET: 'oauth-entry-secret',
    BETTER_AUTH_URL: 'https://auth.test',
    AUTH_UI_URL: 'https://auth-ui.test',
    SSO_UI_URL: 'https://sso.test',
    ACCOUNTS_URL: 'https://accounts.test',
    MCP_URL: 'https://mcp.test',
    API_URL: 'https://api.test',
    MC_AUTH_URL: 'https://mc-auth.test',
    UPSTASH_REDIS_REST_URL: 'https://redis.test',
    UPSTASH_REDIS_REST_TOKEN: 'redis-token',
    HYPERDRIVE: { connectionString: 'postgres://unused' },
    E2E_MOCK_OAUTH_URL: 'https://mock-oauth.test',
    MICROSOFT_CLIENT_ID: 'microsoft-client-id',
    MICROSOFT_CLIENT_SECRET: 'microsoft-client-secret',
  },
}));

const holder = vi.hoisted(() => ({ auth: null as unknown }));

vi.mock('cloudflare:workers', () => ({ env: entryEnv, waitUntil: () => undefined }));

vi.mock('../src/lib/request-auth', () => ({
  withAuth: async (_env: unknown, fn: (auth: never) => Promise<unknown>) => fn(holder.auth as never),
}));

type MemoryDb = {
  user: Record<string, unknown>[];
  session: Record<string, unknown>[];
  account: Record<string, unknown>[];
  verification: Record<string, unknown>[];
};

function buildAuth(db: MemoryDb) {
  return betterAuth({
    secret: SECRET,
    baseURL: BASE_URL,
    trustedOrigins: ['https://auth-ui.test'],
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    plugins: [genericOAuth({ config: getMockOAuthProviders(MOCK_URL) })],
  });
}

async function sessionCookie(auth: ReturnType<typeof buildAuth>): Promise<string> {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ email: 'entry@example.com', name: 'Entry User', emailVerified: true });
  const session = await ctx.internalAdapter.createSession(user.id, false);
  const signature = createHmac('sha256', SECRET).update(session.token).digest('base64');
  return `__Secure-better-auth.session_token=${session.token}.${signature}`;
}

describe('OAuth start through the worker entry', () => {
  it('accepts the link request body and returns the continue URL', async () => {
    const db: MemoryDb = { user: [], session: [], account: [], verification: [] };
    const auth = buildAuth(db);
    holder.auth = auth;

    const response = await worker.fetch(
      new Request(`${BASE_URL}/api/oauth/link`, {
        method: 'POST',
        headers: { cookie: await sessionCookie(auth), 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'github', callbackURL: `karasulab://api/auth/callback/github?state=${NATIVE_STATE}` }),
      }),
    );
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string };
    expect(url.startsWith(`${BASE_URL}/api/oauth/link/continue?ticket=`)).toBe(true);
  });

  it('accepts the sign-in request body and returns the continue URL', async () => {
    const db: MemoryDb = { user: [], session: [], account: [], verification: [] };
    holder.auth = buildAuth(db);

    const response = await worker.fetch(
      new Request(`${BASE_URL}/api/oauth/sign-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'github', callbackURL: `karasulab://api/auth/callback/github?state=${NATIVE_STATE}` }),
      }),
    );
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string };
    expect(url.startsWith(`${BASE_URL}/api/oauth/link/continue?ticket=`)).toBe(true);
  });
});
