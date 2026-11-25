import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { oauthProxyRedirectURI, withOAuthProxyState } from '../src/lib/oauth-proxy';

const SECRET = 'test-better-auth-secret';
const PROXY_SECRET = 'test-oauth-proxy-secret';
const BASE_URL = 'https://feature-a.dev-api-auth.test';
const PROXY_URL = 'https://dev-oauth.test';

const proxyEnv = { BETTER_AUTH_URL: BASE_URL, OAUTH_PROXY_URL: PROXY_URL, OAUTH_PROXY_SECRET: PROXY_SECRET } as Env;
const plainEnv = { BETTER_AUTH_URL: BASE_URL } as Env;

function buildAuth(env: Env) {
  return betterAuth({
    secret: SECRET,
    baseURL: BASE_URL,
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    trustedOrigins: [BASE_URL],
    socialProviders: {
      github: { clientId: 'github-client', clientSecret: 'github-secret', redirectURI: oauthProxyRedirectURI(env, 'github') },
    },
  });
}

async function startSignIn(env: Env, auth: ReturnType<typeof buildAuth>) {
  const raw = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify({ provider: 'github', callbackURL: `${BASE_URL}/after-login?keep=1` }),
    })
  );
  const rawUrl = new URL(((await raw.clone().json()) as { url: string }).url);
  const wrapped = await withOAuthProxyState(env, 'POST', '/api/auth/sign-in/social', raw);
  return { raw, rawUrl, wrapped, wrappedBody: (await wrapped.clone().json()) as { url: string; redirect: boolean } };
}

function decodeState(token: string) {
  const [body, signature] = token.split('.') as [string, string];
  const expected = createHmac('sha256', PROXY_SECRET).update(body).digest('base64url');
  return { valid: expected === signature, payload: JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown> };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('authorization URL rewriting', () => {
  it('points redirect_uri at the proxy and signs state with an HMAC carrying the origin and the original state', async () => {
    const { rawUrl, wrapped, wrappedBody } = await startSignIn(proxyEnv, buildAuth(proxyEnv));
    const url = new URL(wrappedBody.url);
    expect(url.searchParams.get('redirect_uri')).toBe(`${PROXY_URL}/api/auth/callback/github`);
    const { valid, payload } = decodeState(url.searchParams.get('state') as string);
    expect(valid).toBe(true);
    expect(payload.origin).toBe(BASE_URL);
    expect(payload.state).toBe(rawUrl.searchParams.get('state'));
    expect(new URL(wrapped.headers.get('location') as string).searchParams.get('state')).toBe(url.searchParams.get('state'));
  });

  it('leaves every other authorization parameter, including PKCE, untouched', async () => {
    const { rawUrl, wrappedBody } = await startSignIn(proxyEnv, buildAuth(proxyEnv));
    const url = new URL(wrappedBody.url);
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    for (const key of new Set([...rawUrl.searchParams.keys(), ...url.searchParams.keys()])) {
      if (key === 'state' || key === 'redirect_uri') continue;
      expect(url.searchParams.getAll(key)).toEqual(rawUrl.searchParams.getAll(key));
    }
    expect(url.origin + url.pathname).toBe(rawUrl.origin + rawUrl.pathname);
  });

  it('keeps cookies and the redirect flag of the original response', async () => {
    const { raw, wrapped, wrappedBody } = await startSignIn(proxyEnv, buildAuth(proxyEnv));
    expect(wrapped.headers.getSetCookie()).toEqual(raw.headers.getSetCookie());
    expect(wrapped.headers.getSetCookie().length).toBeGreaterThan(0);
    expect(wrappedBody.redirect).toBe(true);
  });

  it('does nothing when no proxy is configured', async () => {
    const { rawUrl, wrapped, wrappedBody } = await startSignIn(plainEnv, buildAuth(plainEnv));
    expect(wrappedBody.url).toBe(rawUrl.toString());
    expect(new URL(wrappedBody.url).searchParams.get('redirect_uri')).toBe(`${BASE_URL}/api/auth/callback/github`);
    expect(wrapped.headers.get('location')).toBe(rawUrl.toString());
  });

  it('ignores other endpoints', async () => {
    const response = Response.json({ url: 'https://idp.test/authorize?state=abc' });
    const result = await withOAuthProxyState(proxyEnv, 'POST', '/api/auth/sign-in/email', response);
    expect(result).toBe(response);
  });
});

describe('callback round trip', () => {
  it('restores the session through the proxy redirect_uri and verifies PKCE at the provider', async () => {
    const auth = buildAuth(proxyEnv);
    const { wrapped, wrappedBody } = await startSignIn(proxyEnv, auth);
    const authorizationUrl = new URL(wrappedBody.url);
    const codeChallenge = authorizationUrl.searchParams.get('code_challenge') as string;
    const tokenRequests: URLSearchParams[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.href === 'https://github.com/login/oauth/access_token') {
          tokenRequests.push(new URLSearchParams(init?.body as URLSearchParams));
          return Response.json({ access_token: 'access', token_type: 'bearer', scope: 'read:user' });
        }
        if (url.href === 'https://api.github.com/user') {
          return Response.json({ id: 42, login: 'octo', name: 'Octo', email: 'octo@example.com', avatar_url: 'https://avatars.test/octo' });
        }
        if (url.href === 'https://api.github.com/user/emails') {
          return Response.json([{ email: 'octo@example.com', primary: true, verified: true, visibility: 'public' }]);
        }
        return new Response('unexpected', { status: 500 });
      })
    );

    const originalState = decodeState(authorizationUrl.searchParams.get('state') as string).payload.state as string;
    const cookie = wrapped.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const callback = await auth.handler(
      new Request(`${BASE_URL}/api/auth/callback/github?code=idp-code&state=${encodeURIComponent(originalState)}`, { headers: { cookie } })
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(`${BASE_URL}/after-login?keep=1`);
    expect(callback.headers.getSetCookie().some((value) => value.includes('session_token'))).toBe(true);

    expect(tokenRequests).toHaveLength(1);
    const tokenRequest = tokenRequests[0] as URLSearchParams;
    expect(tokenRequest.get('code')).toBe('idp-code');
    expect(tokenRequest.get('redirect_uri')).toBe(`${PROXY_URL}/api/auth/callback/github`);
    const verifier = tokenRequest.get('code_verifier') as string;
    expect(verifier).toBeTruthy();
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(codeChallenge);
  });

  it('rejects the callback when the state cookie of another sign-in is used', async () => {
    const auth = buildAuth(proxyEnv);
    const first = await startSignIn(proxyEnv, auth);
    const second = await startSignIn(proxyEnv, auth);
    const secondState = decodeState(new URL(second.wrappedBody.url).searchParams.get('state') as string).payload.state as string;
    const cookie = first.wrapped.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const callback = await auth.handler(
      new Request(`${BASE_URL}/api/auth/callback/github?code=idp-code&state=${encodeURIComponent(secondState)}`, { headers: { cookie } })
    );
    expect(callback.headers.get('location')).not.toBe(`${BASE_URL}/after-login?keep=1`);
    expect(callback.headers.getSetCookie().some((value) => value.includes('session_token'))).toBe(false);
  });
});
