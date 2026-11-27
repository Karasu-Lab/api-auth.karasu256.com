import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { createSocialProviders } from '../src/lib/social-providers';
import { createOAuthProxyStub } from './oauth-proxy-stub';

const SECRET = 'oauth-proxy-round-trip-secret';
const PROXY_SECRET = 'oauth-proxy-secret';
const BASE_URL = 'https://dev-api-auth.test';
const AUTH_UI_URL = 'https://dev-auth.test';
const PROXY_URL = 'https://dev-oauth.test';
const NATIVE_CALLBACK = 'karasulab://api/auth/callback/github?state=native-state-0123456789';

const { entryEnv } = vi.hoisted(() => ({
  entryEnv: {
    APP_ENV: 'preview',
    BASE_DOMAIN: 'karasu256.com',
    BETTER_AUTH_SECRET: 'oauth-proxy-round-trip-secret',
    BETTER_AUTH_URL: 'https://dev-api-auth.test',
    AUTH_UI_URL: 'https://dev-auth.test',
    SSO_UI_URL: 'https://sso.test',
    ACCOUNTS_URL: 'https://accounts.test',
    MCP_URL: 'https://mcp.test',
    API_URL: 'https://api.test',
    MC_AUTH_URL: 'https://mc-auth.test',
    UPSTASH_REDIS_REST_URL: 'https://redis.test',
    UPSTASH_REDIS_REST_TOKEN: 'redis-token',
    HYPERDRIVE: { connectionString: 'postgres://unused' },
    GH_CLIENT_ID: 'github-client',
    GH_CLIENT_SECRET: 'github-secret',
    OAUTH_PROXY_URL: 'https://dev-oauth.test',
    OAUTH_PROXY_SECRET: 'oauth-proxy-secret',
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
    trustedOrigins: [AUTH_UI_URL],
    database: memoryAdapter(db),
    account: {
      encryptOAuthTokens: true,
      accountLinking: { enabled: true, allowDifferentEmails: true, updateUserInfoOnLink: true },
    },
    socialProviders: createSocialProviders(entryEnv as unknown as Env),
  });
}

function stubGitHub() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.href === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'access', token_type: 'bearer', scope: 'read:user' });
      }
      if (url.href === 'https://api.github.com/user') {
        return Response.json({ id: 42, login: 'octo', name: 'Octo', email: 'octo@example.com', avatar_url: 'https://avatars.test/octo' });
      }
      if (url.href === 'https://api.github.com/user/emails') {
        return Response.json([{ email: 'octo@example.com', primary: true, verified: true, visibility: 'public' }]);
      }
      return new Response('unexpected', { status: 500 });
    }),
  );
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OAuth sign-in through the proxy host', () => {
  it('completes the round trip and lands on the auth UI callback with a session', async () => {
    const db: MemoryDb = { user: [], session: [], account: [], verification: [] };
    holder.auth = buildAuth(db);
    stubGitHub();
    const proxy = createOAuthProxyStub(PROXY_SECRET);

    const started = await worker.fetch(
      new Request(`${BASE_URL}/api/oauth/sign-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'github', callbackURL: NATIVE_CALLBACK }),
      }),
    );
    expect(started.status).toBe(200);
    const { url: continueUrl } = (await started.json()) as { url: string };
    expect(continueUrl.startsWith(`${BASE_URL}/api/oauth/link/continue?ticket=`)).toBe(true);

    const continued = await worker.fetch(new Request(continueUrl));
    expect(continued.status).toBe(302);
    const cookies = cookieHeader(continued);
    const authorizationUrl = new URL(continued.headers.get('location') as string);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(`${PROXY_URL}/api/auth/callback/github`);
    const signedState = authorizationUrl.searchParams.get('state') as string;
    expect(signedState).toContain('.');

    const forwarded = await proxy(new Request(`${PROXY_URL}/api/auth/callback/github?code=idp-code&state=${encodeURIComponent(signedState)}`));
    expect(forwarded.status).toBe(302);
    const callbackUrl = new URL(forwarded.headers.get('location') as string);
    expect(callbackUrl.origin + callbackUrl.pathname).toBe(`${BASE_URL}/api/auth/callback/github`);
    expect(callbackUrl.searchParams.get('code')).toBe('idp-code');
    expect(callbackUrl.searchParams.get('state')).not.toBe(signedState);

    const callback = await worker.fetch(new Request(callbackUrl, { headers: { cookie: cookies } }));
    expect(callback.status).toBe(302);
    const landed = new URL(callback.headers.get('location') as string);
    expect(landed.origin + landed.pathname).toBe(`${AUTH_UI_URL}/auth/callback`);
    expect(landed.searchParams.get('error')).toBeNull();
    expect(decodeURIComponent(landed.searchParams.get('next') as string)).toBe(NATIVE_CALLBACK);
    expect(callback.headers.getSetCookie().some((value) => value.includes('session_token'))).toBe(true);
    expect(db.user).toHaveLength(1);
    expect(db.session).toHaveLength(1);
  });

  it('rejects a callback whose state signature was tampered with', async () => {
    const proxy = createOAuthProxyStub(PROXY_SECRET);
    const response = await proxy(new Request(`${PROXY_URL}/api/auth/callback/github?code=idp-code&state=AAAA.invalid`));
    expect(response.status).toBe(400);
  });
});
