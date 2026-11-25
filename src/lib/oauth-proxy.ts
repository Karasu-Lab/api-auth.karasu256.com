import { z } from 'zod';

export function getOAuthProxyConfig(env: Env) {
  if (!env.OAUTH_PROXY_URL) return null;
  if (env.APP_ENV !== 'production' && !env.OAUTH_PROXY_SECRET) return null;
  return {
    url: new URL(env.OAUTH_PROXY_URL).origin,
    secret: env.APP_ENV === 'production' ? null : (env.OAUTH_PROXY_SECRET ?? null),
    origin: new URL(env.BETTER_AUTH_URL).origin,
    ttlMs: 10 * 60 * 1000,
  };
}

export function oauthProxyRedirectURI(env: Env, provider: string) {
  const config = getOAuthProxyConfig(env);
  return config ? `${config.url}/api/auth/callback/${provider}` : undefined;
}

function encodeBase64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function signProxyState(config: { secret: string; origin: string; ttlMs: number }, state: string, now = Date.now()) {
  const body = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify({ origin: config.origin, state, exp: now + config.ttlMs, nonce: crypto.randomUUID() }))
  );
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(config.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return `${body}.${encodeBase64Url(signature)}`;
}

function replaceState(url: string, state: string) {
  const authorizationUrl = new URL(url);
  authorizationUrl.searchParams.set('state', state);
  return authorizationUrl.toString();
}

export async function withOAuthProxyState(env: Env, method: string, pathname: string, response: Response) {
  const config = getOAuthProxyConfig(env);
  if (!config?.secret || method !== 'POST' || !['/api/auth/sign-in/social', '/api/auth/link-social'].includes(pathname)) return response;

  const parsed = z
    .looseObject({ url: z.url() })
    .safeParse(await response.clone().json().catch(() => null));
  if (!parsed.success) return response;
  const body = parsed.data;

  const originalState = new URL(body.url).searchParams.get('state');
  if (!originalState) return response;

  const signed = await signProxyState({ ...config, secret: config.secret }, originalState);
  const headers = new Headers(response.headers);
  if (headers.has('location')) headers.set('location', replaceState(headers.get('location') as string, signed));
  headers.delete('content-length');
  return new Response(JSON.stringify({ ...body, url: replaceState(body.url, signed) }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
