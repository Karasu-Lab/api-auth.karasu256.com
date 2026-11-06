import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { multiSession } from 'better-auth/plugins';
import { jwt } from 'better-auth/plugins/jwt';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { McpSessionTokenDispatch } from '../src/dispatch/mcp';
import type { DispatchContext } from '../src/lib/dispatch';

const SECRET = 'test-better-auth-secret';

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

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('McpSessionTokenDispatch', () => {
  it('exchanges an OAuth access token for a session JWT', async () => {
    const realAuth = betterAuth({
      secret: SECRET,
      baseURL: 'https://auth.test',
      database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [] }),
      emailAndPassword: { enabled: true },
      plugins: [jwt(), multiSession({ maximumSessions: 5 })],
    });
    const authContext = await realAuth.$context;
    const user = await authContext.internalAdapter.createUser({
      email: 'test@example.com',
      name: 'Test User',
      emailVerified: true,
    });
    const session = await authContext.internalAdapter.createSession(user.id, false);
    holder.row = { id: session.id, userId: session.userId, token: session.token, expiresAt: session.expiresAt };

    const accessToken = `${base64UrlJson({ alg: 'EdDSA', typ: 'JWT' })}.${base64UrlJson({ sub: user.id, sid: session.id })}.${Buffer.from('signature').toString('base64url')}`;
    holder.auth = {
      handler: async (request: Request): Promise<Response> => {
        if (request.url.endsWith('/api/auth/oauth2/userinfo') && request.headers.get('authorization') === `Bearer ${accessToken}`) {
          return Response.json({ sub: user.id });
        }
        return new Response(null, { status: 401 });
      },
      api: realAuth.api,
      $context: realAuth.$context,
    };

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
    const dispatch = new McpSessionTokenDispatch(context);
    expect(dispatch.matches()).toBe(true);
    const response = await dispatch.handle();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string };
    expect(typeof body.token).toBe('string');
    const jwksResponse = await realAuth.handler(new Request('https://auth.test/api/auth/jwks'));
    const jwks = (await jwksResponse.json()) as { keys: Record<string, unknown>[] };
    const { payload } = await jwtVerify(body.token, createLocalJWKSet({ keys: jwks.keys }), { issuer: 'https://auth.test' });
    expect(payload.sub).toBe(user.id);
  });
});
