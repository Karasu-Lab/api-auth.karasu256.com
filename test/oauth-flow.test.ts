import { oauthProvider } from '@better-auth/oauth-provider';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { multiSession } from 'better-auth/plugins';
import { jwt } from 'better-auth/plugins/jwt';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createLocalJWKSet, decodeJwt, jwtVerify } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { McpSessionTokenDispatch } from '../src/dispatch/mcp';
import type { DispatchContext } from '../src/lib/dispatch';

const SECRET = 'test-better-auth-secret';
const MCP_URL = 'https://mcp.test/mcp';
const REDIRECT_URI = 'https://client.test/callback';

const holder = vi.hoisted(() => ({
  row: null as { id: string; userId: string; token: string; expiresAt: Date } | null,
  auth: null as unknown,
}));

vi.mock('cloudflare:workers', () => ({ waitUntil: () => undefined }));

vi.mock('@karasu-lab/db/create-db', () => ({
  createDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (holder.row ? [holder.row] : []),
        }),
      }),
    }),
    $client: { end: async () => undefined },
  }),
}));

vi.mock('../src/lib/request-auth', () => ({
  withAuth: async (_env: unknown, fn: (auth: unknown) => Promise<unknown>) => fn(holder.auth),
}));

type AuthInstance = ReturnType<typeof buildAuth>;

type MemoryDb = {
  user: Record<string, unknown>[];
  session: Record<string, unknown>[];
  account: Record<string, unknown>[];
  verification: Record<string, unknown>[];
  jwks: Record<string, unknown>[];
  oauthClient: Record<string, unknown>[];
  oauthAccessToken: Record<string, unknown>[];
  oauthRefreshToken: Record<string, unknown>[];
  oauthConsent: Record<string, unknown>[];
  oauthResource: Record<string, unknown>[];
  oauthClientResource: Record<string, unknown>[];
  oauthClientAssertion: Record<string, unknown>[];
};

function createDb(): MemoryDb {
  return {
    user: [],
    session: [],
    account: [],
    verification: [],
    jwks: [],
    oauthClient: [],
    oauthAccessToken: [],
    oauthRefreshToken: [],
    oauthConsent: [],
    oauthResource: [],
    oauthClientResource: [],
    oauthClientAssertion: [],
  };
}

function buildAuth(db: MemoryDb = createDb()) {
  return betterAuth({
    secret: SECRET,
    baseURL: 'https://auth.test',
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    plugins: [
      jwt(),
      multiSession({ maximumSessions: 5 }),
      oauthProvider({
        loginPage: 'https://auth.test/sign-in',
        consentPage: 'https://auth.test/oauth/consent',
        scopes: ['openid', 'profile', 'email', 'offline_access', 'read:profile', 'write:profile'],
        resources: [MCP_URL],
        clientRegistrationAllowedResources: [MCP_URL],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        accessTokenExpiresIn: 15 * 60,
        refreshTokenReuseInterval: 30,
      }),
    ],
  });
}

function sessionCookieHeader(token: string): string {
  const signature = createHmac('sha256', SECRET).update(token).digest('base64');
  return `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

async function runDispatch(auth: AuthInstance, accessToken: string): Promise<Response> {
  holder.auth = auth;
  const context: DispatchContext = {
    env: {
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: 'https://auth.test',
      DATABASE_URL: 'postgres://unused',
    } as Env,
    request: new Request('https://api-auth.test/api/internal/mcp/session-token', { method: 'POST' }),
    pathname: '/api/internal/mcp/session-token',
    body: { accessToken },
  };
  return new McpSessionTokenDispatch(context).handle();
}

describe('MCP session token exchange with provider-issued tokens', () => {
  it('exchanges the initial and refreshed access tokens for session JWTs', async () => {
    const auth = buildAuth();
    const authContext = await auth.$context;
    const user = await authContext.internalAdapter.createUser({
      email: 'test@example.com',
      name: 'Test User',
      emailVerified: true,
    });
    const session = await authContext.internalAdapter.createSession(user.id, false);
    holder.row = { id: session.id, userId: session.userId, token: session.token, expiresAt: session.expiresAt };
    const cookie = sessionCookieHeader(session.token);

    const registration = await auth.handler(
      new Request('https://auth.test/api/auth/oauth2/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Flow Test Client',
          redirect_uris: [REDIRECT_URI],
          scope: 'openid profile email offline_access read:profile write:profile',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          resources: [MCP_URL],
        }),
      })
    );
    expect(registration.status).toBe(201);
    const client = (await registration.json()) as { client_id: string };
    expect(client.client_id).toBeTruthy();

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorizeParams = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      scope: 'openid profile email offline_access read:profile write:profile',
      resource: MCP_URL,
      state: 'flow-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    let next: Response = await auth.handler(
      new Request(`https://auth.test/api/auth/oauth2/authorize?${authorizeParams}`, { headers: { cookie }, redirect: 'manual' })
    );
    let code: string | null = null;
    for (let step = 0; step < 6 && !code; step++) {
      const location = next.headers.get('location');
      if (next.status >= 300 && next.status < 400 && location) {
        const url = new URL(location, 'https://auth.test');
        if (url.href.startsWith(REDIRECT_URI)) {
          code = url.searchParams.get('code');
          break;
        }
        if (url.pathname === '/oauth/consent') {
          next = await auth.handler(
            new Request('https://auth.test/api/auth/oauth2/consent', {
              method: 'POST',
              headers: { cookie, 'content-type': 'application/json' },
              body: JSON.stringify({ accept: true, oauth_query: url.search.replace(/^\?/, '') }),
              redirect: 'manual',
            })
          );
          const consentBody = (await next.clone().json().catch(() => null)) as { url?: string } | null;
          if (consentBody?.url) {
            next = new Response(null, { status: 302, headers: { location: consentBody.url } });
          }
          continue;
        }
        if (url.pathname === '/sign-in') {
          throw new Error(`authorize redirected to the login page at step ${step}`);
        }
        next = await auth.handler(new Request(url, { headers: { cookie }, redirect: 'manual' }));
        continue;
      }
      const continueBody = (await next.clone().json().catch(() => null)) as { url?: string } | null;
      if (continueBody?.url) {
        next = new Response(null, { status: 302, headers: { location: continueBody.url } });
        continue;
      }
      throw new Error(`authorize stopped at step ${step} with status ${next.status}: ${await next.text().catch(() => '')}`);
    }
    expect(code).toBeTruthy();

    const exchange = async (form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string }> => {
      const response = await auth.handler(
        new Request('https://auth.test/api/auth/oauth2/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(form).toString(),
        })
      );
      expect(response.status).toBe(200);
      return (await response.json()) as { access_token: string; refresh_token?: string };
    };

    const tokens = await exchange({
      grant_type: 'authorization_code',
      code: code as string,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      code_verifier: verifier,
    });
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();

    const initialClaims = decodeJwt(tokens.access_token);
    expect(initialClaims.sub).toBe(user.id);
    expect(initialClaims.sid).toBe(session.id);
    const initialAud = Array.isArray(initialClaims.aud) ? initialClaims.aud : [initialClaims.aud];
    expect(initialAud).toContain(MCP_URL);

    const jwksForVerify = (await (await auth.handler(new Request('https://auth.test/api/auth/jwks'))).json()) as {
      keys: Record<string, unknown>[];
    };
    const verifyAsMcpServer = async (token: string): Promise<void> => {
      const { payload } = await jwtVerify(token, createLocalJWKSet({ keys: jwksForVerify.keys }), {
        issuer: 'https://auth.test/api/auth',
        audience: MCP_URL,
      });
      expect(payload.sub).toBe(user.id);
      const userinfo = await auth.handler(
        new Request('https://auth.test/api/auth/oauth2/userinfo', { headers: { authorization: `Bearer ${token}` } })
      );
      expect(userinfo.status).toBe(200);
      const info = (await userinfo.json()) as { sub: string };
      expect(info.sub).toBe(user.id);
    };
    await verifyAsMcpServer(tokens.access_token);

    const exchanged = await runDispatch(auth, tokens.access_token);
    expect(exchanged.status).toBe(200);
    const exchangedBody = (await exchanged.json()) as { token: string };
    const jwksResponse = await auth.handler(new Request('https://auth.test/api/auth/jwks'));
    const jwks = (await jwksResponse.json()) as { keys: Record<string, unknown>[] };
    const { payload } = await jwtVerify(exchangedBody.token, createLocalJWKSet({ keys: jwks.keys }), { issuer: 'https://auth.test' });
    expect(payload.sub).toBe(user.id);

    const refreshed = await exchange({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token as string,
      client_id: client.client_id,
    });
    expect(refreshed.access_token).toBeTruthy();
    const refreshedClaims = decodeJwt(refreshed.access_token);
    expect(refreshedClaims.sub).toBe(user.id);
    expect(refreshedClaims.sid).toBe(session.id);
    const refreshedAud = Array.isArray(refreshedClaims.aud) ? refreshedClaims.aud : [refreshedClaims.aud];
    expect(refreshedAud).toContain(MCP_URL);

    await verifyAsMcpServer(refreshed.access_token);

    const exchangedAfterRefresh = await runDispatch(auth, refreshed.access_token);
    expect(exchangedAfterRefresh.status).toBe(200);
  });

  it('refreshes a token for a client registered without the refresh_token grant type', async () => {
    const auth = buildAuth();
    const authContext = await auth.$context;
    const user = await authContext.internalAdapter.createUser({
      email: 'second@example.com',
      name: 'Second User',
      emailVerified: true,
    });
    const session = await authContext.internalAdapter.createSession(user.id, false);
    holder.row = { id: session.id, userId: session.userId, token: session.token, expiresAt: session.expiresAt };
    const cookie = sessionCookieHeader(session.token);

    const registration = await auth.handler(
      new Request('https://auth.test/api/auth/oauth2/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Code Only Client',
          redirect_uris: [REDIRECT_URI],
          scope: 'openid profile email offline_access read:profile write:profile',
          grant_types: ['authorization_code'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          resources: [MCP_URL],
        }),
      })
    );
    expect(registration.status).toBe(201);
    const client = (await registration.json()) as { client_id: string };

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorizeParams = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      scope: 'openid profile email offline_access read:profile write:profile',
      resource: MCP_URL,
      state: 'flow-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    let next: Response = await auth.handler(
      new Request(`https://auth.test/api/auth/oauth2/authorize?${authorizeParams}`, { headers: { cookie }, redirect: 'manual' })
    );
    let code: string | null = null;
    for (let step = 0; step < 6 && !code; step++) {
      const location = next.headers.get('location');
      if (next.status >= 300 && next.status < 400 && location) {
        const url = new URL(location, 'https://auth.test');
        if (url.href.startsWith(REDIRECT_URI)) {
          code = url.searchParams.get('code');
          break;
        }
        if (url.pathname === '/oauth/consent') {
          next = await auth.handler(
            new Request('https://auth.test/api/auth/oauth2/consent', {
              method: 'POST',
              headers: { cookie, 'content-type': 'application/json' },
              body: JSON.stringify({ accept: true, oauth_query: url.search.replace(/^\?/, '') }),
              redirect: 'manual',
            })
          );
          const consentBody = (await next.clone().json().catch(() => null)) as { url?: string } | null;
          if (consentBody?.url) {
            next = new Response(null, { status: 302, headers: { location: consentBody.url } });
          }
          continue;
        }
        next = await auth.handler(new Request(url, { headers: { cookie }, redirect: 'manual' }));
        continue;
      }
      const continueBody = (await next.clone().json().catch(() => null)) as { url?: string } | null;
      if (continueBody?.url) {
        next = new Response(null, { status: 302, headers: { location: continueBody.url } });
        continue;
      }
      throw new Error(`authorize stopped at step ${step} with status ${next.status}`);
    }
    expect(code).toBeTruthy();

    const tokenResponse = await auth.handler(
      new Request('https://auth.test/api/auth/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code as string,
          redirect_uri: REDIRECT_URI,
          client_id: client.client_id,
          code_verifier: verifier,
        }).toString(),
      })
    );
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as { access_token: string; refresh_token?: string };
    expect(tokens.refresh_token).toBeTruthy();

    const refreshResponse = await auth.handler(
      new Request('https://auth.test/api/auth/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token as string,
          client_id: client.client_id,
        }).toString(),
      })
    );
    const refreshBody = (await refreshResponse.clone().json().catch(() => null)) as { access_token?: string; error?: string } | null;
    expect(refreshResponse.status).toBe(200);
    expect(refreshBody?.access_token).toBeTruthy();
  });

  it('keeps the connection alive when a rotated refresh token is presented twice', async () => {
    const auth = buildAuth();
    const authContext = await auth.$context;
    const user = await authContext.internalAdapter.createUser({
      email: 'third@example.com',
      name: 'Third User',
      emailVerified: true,
    });
    const session = await authContext.internalAdapter.createSession(user.id, false);
    holder.row = { id: session.id, userId: session.userId, token: session.token, expiresAt: session.expiresAt };
    const cookie = sessionCookieHeader(session.token);

    const registration = await auth.handler(
      new Request('https://auth.test/api/auth/oauth2/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Rotation Client',
          redirect_uris: [REDIRECT_URI],
          scope: 'openid profile email offline_access read:profile write:profile',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          resources: [MCP_URL],
        }),
      })
    );
    expect(registration.status).toBe(201);
    const client = (await registration.json()) as { client_id: string };

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorizeParams = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      scope: 'openid profile email offline_access read:profile write:profile',
      resource: MCP_URL,
      state: 'flow-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    let next: Response = await auth.handler(
      new Request(`https://auth.test/api/auth/oauth2/authorize?${authorizeParams}`, { headers: { cookie }, redirect: 'manual' })
    );
    let code: string | null = null;
    for (let step = 0; step < 6 && !code; step++) {
      const location = next.headers.get('location');
      if (next.status >= 300 && next.status < 400 && location) {
        const url = new URL(location, 'https://auth.test');
        if (url.href.startsWith(REDIRECT_URI)) {
          code = url.searchParams.get('code');
          break;
        }
        if (url.pathname === '/oauth/consent') {
          next = await auth.handler(
            new Request('https://auth.test/api/auth/oauth2/consent', {
              method: 'POST',
              headers: { cookie, 'content-type': 'application/json' },
              body: JSON.stringify({ accept: true, oauth_query: url.search.replace(/^\?/, '') }),
              redirect: 'manual',
            })
          );
          const consentBody = (await next.clone().json().catch(() => null)) as { url?: string } | null;
          if (consentBody?.url) {
            next = new Response(null, { status: 302, headers: { location: consentBody.url } });
          }
          continue;
        }
        next = await auth.handler(new Request(url, { headers: { cookie }, redirect: 'manual' }));
        continue;
      }
      const continueBody = (await next.clone().json().catch(() => null)) as { url?: string } | null;
      if (continueBody?.url) {
        next = new Response(null, { status: 302, headers: { location: continueBody.url } });
        continue;
      }
      throw new Error(`authorize stopped at step ${step} with status ${next.status}`);
    }
    expect(code).toBeTruthy();

    const postToken = async (form: Record<string, string>): Promise<{ status: number; body: { access_token?: string; refresh_token?: string; error?: string } }> => {
      const response = await auth.handler(
        new Request('https://auth.test/api/auth/oauth2/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(form).toString(),
        })
      );
      return { status: response.status, body: (await response.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; error?: string } };
    };

    const initial = await postToken({
      grant_type: 'authorization_code',
      code: code as string,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      code_verifier: verifier,
    });
    expect(initial.status).toBe(200);
    const firstRefreshToken = initial.body.refresh_token as string;
    expect(firstRefreshToken).toBeTruthy();

    const firstRefresh = await postToken({ grant_type: 'refresh_token', refresh_token: firstRefreshToken, client_id: client.client_id });
    expect(firstRefresh.status).toBe(200);
    const secondRefreshToken = firstRefresh.body.refresh_token as string;
    expect(secondRefreshToken).toBeTruthy();
    expect(secondRefreshToken).not.toBe(firstRefreshToken);

    const reused = await postToken({ grant_type: 'refresh_token', refresh_token: firstRefreshToken, client_id: client.client_id });
    expect(reused.status).toBe(200);
    expect(reused.body.access_token).toBeTruthy();

    const afterReuse = await postToken({ grant_type: 'refresh_token', refresh_token: secondRefreshToken, client_id: client.client_id });
    expect(afterReuse.status).toBe(200);
    expect(afterReuse.body.access_token).toBeTruthy();
  });

  it('revokes the family when a rotated token is presented after the reuse interval', async () => {
    const db = createDb();
    const auth = buildAuth(db);
    const authContext = await auth.$context;
    const user = await authContext.internalAdapter.createUser({
      email: 'fourth@example.com',
      name: 'Fourth User',
      emailVerified: true,
    });
    const session = await authContext.internalAdapter.createSession(user.id, false);
    holder.row = { id: session.id, userId: session.userId, token: session.token, expiresAt: session.expiresAt };
    const cookie = sessionCookieHeader(session.token);

    const registration = await auth.handler(
      new Request('https://auth.test/api/auth/oauth2/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Late Reuse Client',
          redirect_uris: [REDIRECT_URI],
          scope: 'openid profile email offline_access read:profile write:profile',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          resources: [MCP_URL],
        }),
      })
    );
    expect(registration.status).toBe(201);
    const client = (await registration.json()) as { client_id: string };

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorizeParams = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      scope: 'openid profile email offline_access read:profile write:profile',
      resource: MCP_URL,
      state: 'flow-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    let next: Response = await auth.handler(
      new Request(`https://auth.test/api/auth/oauth2/authorize?${authorizeParams}`, { headers: { cookie }, redirect: 'manual' })
    );
    let code: string | null = null;
    for (let step = 0; step < 6 && !code; step++) {
      const location = next.headers.get('location');
      if (next.status >= 300 && next.status < 400 && location) {
        const url = new URL(location, 'https://auth.test');
        if (url.href.startsWith(REDIRECT_URI)) {
          code = url.searchParams.get('code');
          break;
        }
        if (url.pathname === '/oauth/consent') {
          next = await auth.handler(
            new Request('https://auth.test/api/auth/oauth2/consent', {
              method: 'POST',
              headers: { cookie, 'content-type': 'application/json' },
              body: JSON.stringify({ accept: true, oauth_query: url.search.replace(/^\?/, '') }),
              redirect: 'manual',
            })
          );
          const consentBody = (await next.clone().json().catch(() => null)) as { url?: string } | null;
          if (consentBody?.url) {
            next = new Response(null, { status: 302, headers: { location: consentBody.url } });
          }
          continue;
        }
        next = await auth.handler(new Request(url, { headers: { cookie }, redirect: 'manual' }));
        continue;
      }
      const continueBody = (await next.clone().json().catch(() => null)) as { url?: string } | null;
      if (continueBody?.url) {
        next = new Response(null, { status: 302, headers: { location: continueBody.url } });
        continue;
      }
      throw new Error(`authorize stopped at step ${step} with status ${next.status}`);
    }
    expect(code).toBeTruthy();

    const postToken = async (form: Record<string, string>): Promise<{ status: number; body: { access_token?: string; refresh_token?: string; error?: string } }> => {
      const response = await auth.handler(
        new Request('https://auth.test/api/auth/oauth2/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(form).toString(),
        })
      );
      return { status: response.status, body: (await response.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; error?: string } };
    };

    const initial = await postToken({
      grant_type: 'authorization_code',
      code: code as string,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      code_verifier: verifier,
    });
    expect(initial.status).toBe(200);
    const firstRefreshToken = initial.body.refresh_token as string;

    const firstRefresh = await postToken({ grant_type: 'refresh_token', refresh_token: firstRefreshToken, client_id: client.client_id });
    expect(firstRefresh.status).toBe(200);
    const secondRefreshToken = firstRefresh.body.refresh_token as string;
    expect(secondRefreshToken).toBeTruthy();

    const rotatedRow = db.oauthRefreshToken.find((row) => row.revoked != null && row.rotationReplayExpiresAt != null);
    expect(rotatedRow).toBeTruthy();
    (rotatedRow as Record<string, unknown>).rotationReplayExpiresAt = new Date(0);

    const lateReuse = await postToken({ grant_type: 'refresh_token', refresh_token: firstRefreshToken, client_id: client.client_id });
    expect(lateReuse.status).toBe(400);
    expect(lateReuse.body.error).toBe('invalid_grant');

    const afterLateReuse = await postToken({ grant_type: 'refresh_token', refresh_token: secondRefreshToken, client_id: client.client_id });
    expect(afterLateReuse.status).toBe(400);
    expect(afterLateReuse.body.error).toBe('invalid_grant');
  });
});
