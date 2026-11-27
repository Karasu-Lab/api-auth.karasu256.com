import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { handleOAuthLink, handleOAuthLinkHandoff } from '../src/routes/oauth-link';
import { handleXboxLink } from '../src/routes/xbox';

vi.mock('../src/lib/request-auth', () => ({
  withAuth: (_env: Env, callback: (auth: unknown) => Promise<unknown>) =>
    callback({ api: { getSession: async () => ({ user: { id: 'user-1' } }) } }),
}));

vi.mock('../src/lib/xbox-link', () => ({
  buildXboxAuthorizeUrl: (clientId: string, redirectUri: string, state: string) => {
    const url = new URL('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  },
  createXboxLinkState: async (_secret: string, userId: string, app: boolean, callbackURL?: string, providerId?: string) =>
    JSON.stringify({ userId, ...(app && { app }), ...(callbackURL && { callbackURL, providerId }) }),
}));

const env = {
  APP_ENV: 'preview',
  BETTER_AUTH_URL: 'https://feature-a.dev-api-auth.test',
  BETTER_AUTH_SECRET: 'auth-secret',
  ACCOUNTS_URL: 'https://accounts.karasu256.com',
  MICROSOFT_CLIENT_ID: 'microsoft-client',
  MICROSOFT_CLIENT_SECRET: 'microsoft-secret',
  OAUTH_PROXY_URL: 'https://dev-oauth.karasu256.com',
  OAUTH_PROXY_SECRET: 'proxy-secret',
} as Env;

describe('Xbox provider OAuth proxy flow', () => {
  it('uses the OAuth proxy callback and signs provider state', async () => {
    const response = await handleXboxLink(env, new Request(`${env.BETTER_AUTH_URL}/api/xbox/link`));
    const authorizationURL = new URL(response.headers.get('location') ?? '');
    expect(authorizationURL.searchParams.get('redirect_uri')).toBe(`${env.OAUTH_PROXY_URL}/api/auth/callback/xbox`);

    const [payload, signature] = (authorizationURL.searchParams.get('state') ?? '').split('.');
    expect(payload).toBeTruthy();
    expect(signature).toBeTruthy();
    expect(createHmac('sha256', env.OAUTH_PROXY_SECRET as string).update(payload as string).digest('base64url')).toBe(signature);

    const proxyState = JSON.parse(Buffer.from(payload as string, 'base64url').toString()) as { origin: string; state: string };
    expect(proxyState.origin).toBe(env.BETTER_AUTH_URL);
    expect(JSON.parse(proxyState.state)).toEqual({ userId: 'user-1' });
  });

  it('starts Xbox linking through the generic native OAuth link endpoint', async () => {
    const callbackURL = 'karasulab://api/auth/callback/xbox?state=native-state-1234567890';
    const response = await handleOAuthLink(
      env,
      new Request(`${env.BETTER_AUTH_URL}/api/oauth/link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'xbox', callbackURL }),
      }),
    );
    const result = (await response.json()) as { url: string };
    const handoff = await handleOAuthLinkHandoff(env, new Request(result.url));
    const authorizationURL = new URL(handoff.headers.get('location') ?? '');
    expect(authorizationURL.searchParams.get('redirect_uri')).toBe(`${env.OAUTH_PROXY_URL}/api/auth/callback/xbox`);

    const [payload, signature] = (authorizationURL.searchParams.get('state') ?? '').split('.');
    expect(createHmac('sha256', env.OAUTH_PROXY_SECRET as string).update(payload as string).digest('base64url')).toBe(signature);
    const proxyState = JSON.parse(Buffer.from(payload as string, 'base64url').toString()) as { state: string };
    expect(JSON.parse(proxyState.state)).toMatchObject({ userId: 'user-1', callbackURL, providerId: 'xbox' });
  });
});
