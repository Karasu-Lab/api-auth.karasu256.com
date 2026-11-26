import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockAuthHandler } = vi.hoisted(() => ({ mockAuthHandler: vi.fn() }));

vi.mock('../src/lib/request-auth', () => ({
  withAuth: (_env: Env, callback: (auth: unknown) => Promise<unknown>) =>
    callback({
      api: { getSession: async () => ({ user: { id: 'user-1' } }) },
      handler: mockAuthHandler,
    }),
}));

vi.mock('../src/routes/xbox', () => ({
  handleXboxAppLink: vi.fn(),
}));

import { handleOAuthLink, handleOAuthLinkHandoff } from '../src/routes/oauth-link';

const env = {
  APP_ENV: 'preview',
  BETTER_AUTH_URL: 'https://feature-a.dev-api-auth.test',
  BETTER_AUTH_SECRET: 'auth-secret',
  AUTH_UI_URL: 'https://feature-a.dev-auth.test',
  OAUTH_PROXY_URL: 'https://dev-oauth.karasu256.com',
  OAUTH_PROXY_SECRET: 'proxy-secret',
  GH_CLIENT_ID: 'github-client',
  GH_CLIENT_SECRET: 'github-secret',
} as Env;

const state = 'native-state-1234567890';
const nativeCallback = `karasulab://api/auth/callback/github?state=${state}`;

beforeEach(() => {
  mockAuthHandler.mockReset();
  mockAuthHandler.mockResolvedValue(
    new Response(
      JSON.stringify({
        url: 'https://github.com/login/oauth/authorize?state=provider-state',
        redirect: false,
      }),
      {
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'oauth_state=browser-cookie; Path=/; HttpOnly; Secure',
        },
      },
    ),
  );
});

describe('generic native OAuth linking', () => {
  it('starts a provider link using the app callback through the auth UI and OAuth proxy', async () => {
    const response = await handleOAuthLink(
      env,
      new Request(`${env.BETTER_AUTH_URL}/api/oauth/link`, {
        method: 'POST',
        headers: { cookie: 'session=secret', 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'github', callbackURL: nativeCallback }),
      }),
    );

    expect(response.status).toBe(200);
    const result = (await response.json()) as { url: string };
    expect(result.url).not.toContain('browser-cookie');
    const handoff = await handleOAuthLinkHandoff(env, new Request(result.url));
    expect(handoff.status).toBe(302);
    expect(handoff.headers.getSetCookie()).toContain('oauth_state=browser-cookie; Path=/; HttpOnly; Secure');
    expect(handoff.headers.get('cache-control')).toBe('no-store');
    const authorizationURL = new URL(handoff.headers.get('location') ?? '');
    expect(authorizationURL.searchParams.get('redirect_uri')).toBe(`${env.OAUTH_PROXY_URL}/api/auth/callback/github`);
    const [payload, signature] = (authorizationURL.searchParams.get('state') ?? '').split('.');
    expect(createHmac('sha256', env.OAUTH_PROXY_SECRET as string).update(payload as string).digest('base64url')).toBe(signature);
    const proxyState = JSON.parse(Buffer.from(payload as string, 'base64url').toString()) as { origin: string; state: string };
    expect(proxyState.origin).toBe(env.BETTER_AUTH_URL);
    expect(proxyState.state).toBe('provider-state');

    const request = mockAuthHandler.mock.calls[0]?.[0] as Request;
    expect(new URL(request.url).pathname).toBe('/api/auth/link-social');
    const body = (await request.json()) as {
      provider: string;
      callbackURL: string;
      errorCallbackURL: string;
      disableRedirect: boolean;
    };
    expect(body.provider).toBe('github');
    expect(body.disableRedirect).toBe(true);
    const callbackURL = new URL(body.callbackURL);
    expect(body.errorCallbackURL).toBe(body.callbackURL);
    expect(callbackURL.pathname).toBe('/auth/callback');
    expect(callbackURL.searchParams.get('flow')).toBe('link');
    expect(callbackURL.searchParams.get('next')).toBe(nativeCallback);
  });

  it('rejects callback URIs that do not match the provider and state format', async () => {
    const response = await handleOAuthLink(
      env,
      new Request(`${env.BETTER_AUTH_URL}/api/oauth/link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'github',
          callbackURL: 'karasulab://api/auth/callback/google?state=short',
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mockAuthHandler).not.toHaveBeenCalled();
  });

  it('rejects invalid handoff tickets', async () => {
    const response = await handleOAuthLinkHandoff(
      env,
      new Request(`${env.BETTER_AUTH_URL}/api/oauth/link/continue?ticket=invalid`),
    );

    expect(response.status).toBe(400);
  });
});
