import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { genericOAuth } from 'better-auth/plugins';
import { decryptOAuthToken } from 'better-auth/oauth2';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMockOAuthProviders } from '../src/lib/mock-oauth';
import { handleOAuthLink, handleOAuthLinkHandoff, handleOAuthSignIn } from '../src/routes/oauth-link';
import { handleXboxCallback } from '../src/routes/xbox';

const SECRET = 'test-better-auth-secret';
const BASE_URL = 'https://auth.test';
const AUTH_UI_URL = 'https://auth-ui.test';
const MOCK_URL = 'https://mock-oauth.test';
const NATIVE_STATE = 'native-state-1234567890';
const XUID = 'xuid-1234';

const holder = vi.hoisted(() => ({ auth: null as unknown }));

vi.mock('cloudflare:workers', () => ({ waitUntil: () => undefined }));

vi.mock('../src/lib/request-auth', () => ({
  withAuth: async (_env: unknown, fn: (auth: unknown) => Promise<unknown>) => fn(holder.auth),
}));

const env = {
  APP_ENV: 'local',
  BETTER_AUTH_URL: BASE_URL,
  BETTER_AUTH_SECRET: SECRET,
  AUTH_UI_URL,
  ACCOUNTS_URL: 'https://accounts.test',
  E2E_MOCK_OAUTH_URL: MOCK_URL,
  MICROSOFT_CLIENT_ID: 'microsoft-client',
  MICROSOFT_CLIENT_SECRET: 'microsoft-secret',
} as Env;

type MemoryDb = {
  user: Record<string, unknown>[];
  session: Record<string, unknown>[];
  account: Record<string, unknown>[];
  verification: Record<string, unknown>[];
};

type AuthInstance = ReturnType<typeof buildAuth>;

function buildAuth(db: MemoryDb) {
  return betterAuth({
    secret: SECRET,
    baseURL: BASE_URL,
    trustedOrigins: [AUTH_UI_URL],
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    plugins: [genericOAuth({ config: getMockOAuthProviders(MOCK_URL) })],
  });
}

function sessionCookieHeader(token: string): string {
  const signature = createHmac('sha256', SECRET).update(token).digest('base64');
  return `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));

  const mockProvider = url.pathname.match(/^\/(google|github|microsoft)\/(token|userinfo)$/);
  if (url.origin === MOCK_URL && mockProvider) {
    const providerId = mockProvider[1] as string;
    if (mockProvider[2] === 'token') {
      return Response.json({
        access_token: `access-${providerId}`,
        refresh_token: `refresh-${providerId}`,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid email profile',
      });
    }
    if (headers.get('authorization') !== `Bearer access-${providerId}`) return Response.json({ error: 'invalid_token' }, { status: 401 });
    return Response.json({
      sub: `mock-user-${providerId}`,
      name: `Mock ${providerId}`,
      email: `mock-${providerId}@example.com`,
      picture: 'https://mock-oauth.test/avatar.png',
      email_verified: true,
    });
  }

  if (url.href === 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token') {
    return Response.json({ access_token: 'ms-access-token', refresh_token: 'ms-refresh-token', expires_in: 3600 });
  }
  if (url.href === 'https://user.auth.xboxlive.com/user/authenticate') {
    return Response.json({
      IssueInstant: new Date().toISOString(),
      NotAfter: new Date(Date.now() + 3600_000).toISOString(),
      Token: 'xbl-token',
      DisplayClaims: { xui: [{ xid: XUID, uhs: 'uhs-1', gt: 'MockGamer' }] },
    });
  }
  if (url.href === 'https://xsts.auth.xboxlive.com/xsts/authorize') {
    return Response.json({
      IssueInstant: new Date().toISOString(),
      NotAfter: new Date(Date.now() + 3600_000).toISOString(),
      Token: 'xsts-token',
      DisplayClaims: { xui: [{ xid: XUID, uhs: 'uhs-1', gt: 'MockGamer' }] },
    });
  }

  return Response.json({ error: 'not_found' }, { status: 404 });
});

async function createSessionUser(auth: AuthInstance, email: string): Promise<{ userId: string; cookie: string }> {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ email, name: 'Flow User', emailVerified: true });
  const session = await ctx.internalAdapter.createSession(user.id, false);
  return { userId: user.id, cookie: sessionCookieHeader(session.token) };
}

async function startNativeLink(providerId: string, cookie: string): Promise<{ authorizeUrl: URL; cookies: string }> {
  const started = await handleOAuthLink(
    env,
    new Request(`${BASE_URL}/api/oauth/link`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: providerId, callbackURL: `karasulab://api/auth/callback/${providerId}?state=${NATIVE_STATE}` }),
    }),
  );
  expect(started.status).toBe(200);
  const { url } = (await started.json()) as { url: string };
  expect(url.startsWith(`${BASE_URL}/api/oauth/link/continue?ticket=`)).toBe(true);

  const continued = await handleOAuthLinkHandoff(env, new Request(url));
  expect(continued.status).toBe(302);
  return { authorizeUrl: new URL(continued.headers.get('location') ?? ''), cookies: cookieHeader(continued) };
}

async function startNativeSignIn(providerId: string): Promise<{ authorizeUrl: URL; cookies: string }> {
  const started = await handleOAuthSignIn(
    env,
    new Request(`${BASE_URL}/api/oauth/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: providerId, callbackURL: `karasulab://api/auth/callback/${providerId}?state=${NATIVE_STATE}` }),
    }),
  );
  expect(started.status).toBe(200);
  const { url } = (await started.json()) as { url: string };
  expect(url.startsWith(`${BASE_URL}/api/oauth/link/continue?ticket=`)).toBe(true);

  const continued = await handleOAuthLinkHandoff(env, new Request(url));
  expect(continued.status).toBe(302);
  return { authorizeUrl: new URL(continued.headers.get('location') ?? ''), cookies: cookieHeader(continued) };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OAuth link flow by provider ID', () => {
  it.each(['google', 'github', 'microsoft'])('links %s end to end and fetches the provider profile', async (providerId) => {
    const db: MemoryDb = { user: [], session: [], account: [], verification: [] };
    const auth = buildAuth(db);
    holder.auth = auth;
    const { userId, cookie } = await createSessionUser(auth, `flow-${providerId}@example.com`);

    const { authorizeUrl, cookies } = await startNativeLink(providerId, cookie);
    expect(authorizeUrl.origin).toBe(MOCK_URL);
    expect(authorizeUrl.pathname).toBe(`/${providerId}/authorize`);

    const redirectUri = authorizeUrl.searchParams.get('redirect_uri') ?? '';
    const providerState = authorizeUrl.searchParams.get('state') ?? '';
    expect(redirectUri).toBeTruthy();
    expect(providerState).toBeTruthy();
    const callback = await auth.handler(
      new Request(`${redirectUri}?code=mock-code&state=${encodeURIComponent(providerState)}`, {
        headers: { cookie: `${cookie}; ${cookies}` },
        redirect: 'manual',
      }),
    );
    expect(callback.status).toBe(302);
    const destination = new URL(callback.headers.get('location') ?? '');
    expect(destination.origin).toBe(AUTH_UI_URL);
    expect(destination.pathname).toBe('/auth/callback');
    expect(destination.searchParams.get('flow')).toBe('link');
    expect(destination.searchParams.get('next')).toBe(`karasulab://api/auth/callback/${providerId}?state=${NATIVE_STATE}`);

    const ctx = await auth.$context;
    const accounts = await ctx.internalAdapter.findAccounts(userId);
    const account = accounts.find((entry) => entry.providerId === providerId);
    expect(account?.accountId).toBe(`mock-user-${providerId}`);
    expect(account?.accessToken).toBeTruthy();
    expect(account?.accessToken).not.toBe(`access-${providerId}`);
    expect(account?.refreshToken).toBeTruthy();
    expect(account?.refreshToken).not.toBe(`refresh-${providerId}`);

    const accessToken = await decryptOAuthToken(account?.accessToken as string, ctx);
    const profileResponse = await fetch(`${MOCK_URL}/${providerId}/userinfo`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(profileResponse.status).toBe(200);
    const profile = (await profileResponse.json()) as { sub: string; name: string; email: string };
    expect(profile.sub).toBe(`mock-user-${providerId}`);
    expect(profile.name).toBe(`Mock ${providerId}`);
    expect(profile.email).toBe(`mock-${providerId}@example.com`);
  });

  it.each(['xbox', 'minecraft'])('links %s end to end through the Microsoft flow', async (providerId) => {
    const db: MemoryDb = { user: [], session: [], account: [], verification: [] };
    const auth = buildAuth(db);
    holder.auth = auth;
    const { userId, cookie } = await createSessionUser(auth, `flow-${providerId}@example.com`);

    const { authorizeUrl } = await startNativeLink(providerId, cookie);
    expect(authorizeUrl.origin).toBe('https://login.microsoftonline.com');
    expect(authorizeUrl.searchParams.get('client_id')).toBe('microsoft-client');
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(`${BASE_URL}/api/xbox/callback`);
    const providerState = authorizeUrl.searchParams.get('state') ?? '';
    expect(providerState).toBeTruthy();

    const callback = await handleXboxCallback(
      env,
      new Request(`${BASE_URL}/api/xbox/callback?code=ms-code&state=${encodeURIComponent(providerState)}`),
    );
    expect(callback.status).toBe(302);
    const destination = new URL(callback.headers.get('location') ?? '');
    expect(destination.protocol).toBe('karasulab:');
    expect(destination.pathname).toBe(`/auth/callback/${providerId}`);
    expect(destination.searchParams.get('linked')).toBe(providerId);
    expect(destination.searchParams.get('error')).toBeNull();

    const ctx = await auth.$context;
    const accounts = await ctx.internalAdapter.findAccounts(userId);
    const account = accounts.find((entry) => entry.providerId === 'xbox');
    expect(account?.accountId).toBe(XUID);
    expect(account?.accessToken).toBeTruthy();
    expect(account?.accessToken).not.toBe('ms-access-token');
    expect(account?.refreshToken).toBeTruthy();
    expect(account?.refreshToken).not.toBe('ms-refresh-token');
  });
});

describe('OAuth sign-in flow by provider ID', () => {
  it.each(['google', 'github', 'microsoft'])('signs in with %s end to end without linking', async (providerId) => {
    const db: MemoryDb = { user: [], session: [], account: [], verification: [] };
    const auth = buildAuth(db);
    holder.auth = auth;

    const { authorizeUrl, cookies } = await startNativeSignIn(providerId);
    expect(authorizeUrl.origin).toBe(MOCK_URL);
    expect(authorizeUrl.pathname).toBe(`/${providerId}/authorize`);

    const redirectUri = authorizeUrl.searchParams.get('redirect_uri') ?? '';
    const providerState = authorizeUrl.searchParams.get('state') ?? '';
    expect(redirectUri).toBeTruthy();
    expect(providerState).toBeTruthy();
    const callback = await auth.handler(
      new Request(`${redirectUri}?code=mock-code&state=${encodeURIComponent(providerState)}`, {
        headers: { cookie: cookies },
        redirect: 'manual',
      }),
    );
    expect(callback.status).toBe(302);
    const destination = new URL(callback.headers.get('location') ?? '');
    expect(destination.origin).toBe(AUTH_UI_URL);
    expect(destination.pathname).toBe('/auth/callback');
    expect(destination.searchParams.get('flow')).toBeNull();
    expect(destination.searchParams.get('next')).toBe(`karasulab://api/auth/callback/${providerId}?state=${NATIVE_STATE}`);

    const user = db.user.find((entry) => entry.email === `mock-${providerId}@example.com`);
    expect(user).toBeTruthy();
    const userId = user?.id as string;
    const ctx = await auth.$context;
    const accounts = await ctx.internalAdapter.findAccounts(userId);
    const account = accounts.find((entry) => entry.providerId === providerId);
    expect(account?.accountId).toBe(`mock-user-${providerId}`);
    expect(account?.accessToken).toBeTruthy();
    expect(account?.accessToken).not.toBe(`access-${providerId}`);
    expect(db.session.some((entry) => entry.userId === userId)).toBe(true);
  });

  it('rejects the Xbox family for sign-in', async () => {
    const response = await handleOAuthSignIn(
      env,
      new Request(`${BASE_URL}/api/oauth/sign-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'xbox', callbackURL: `karasulab://api/auth/callback/xbox?state=${NATIVE_STATE}` }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'unsupported_oauth_provider' });
  });
});
