import { setTokenUtil } from 'better-auth/oauth2';
import type { AuthContext } from '@better-auth/core';
import type { XboxLinkExchange, XboxLinkTokens } from '@karasu-lab/types/server';
import { authenticateXboxLive, authorizeXsts, XBOX_RELYING_PARTY } from './xbox-live';

export type { XboxLinkExchange, XboxLinkTokens };

export const XBOX_PROVIDER_ID = 'xbox';
export const XBOX_SCOPE = 'XboxLive.signin offline_access';
const MICROSOFT_AUTHORIZE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const STATE_TTL_MS = 10 * 60 * 1000;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function createXboxLinkState(secret: string, userId: string): Promise<string> {
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ userId, exp: Date.now() + STATE_TTL_MS })));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyXboxLinkState(secret: string, state: string): Promise<string | null> {
  const [payload, signature] = state.split('.');
  if (!payload || !signature) return null;
  const valid = await crypto.subtle
    .verify('HMAC', await hmacKey(secret), base64UrlDecode(signature), new TextEncoder().encode(payload))
    .catch(() => false);
  if (!valid) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as { userId?: string; exp?: number };
    if (!parsed.userId || !parsed.exp || parsed.exp < Date.now()) return null;
    return parsed.userId;
  } catch {
    return null;
  }
}

export function buildXboxAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL(MICROSOFT_AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', XBOX_SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

export async function exchangeXboxLinkCode(
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string
): Promise<XboxLinkExchange> {
  const res = await fetch(MICROSOFT_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      scope: XBOX_SCOPE,
    }),
  }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  } | null;
  if (!res?.ok || !body?.access_token) {
    return {
      tokens: null,
      error: body?.error ?? 'xbox_token_exchange_failed',
      errorDescription: body?.error_description ?? `Microsoft's token endpoint answered ${res?.status ?? 'no response'}.`,
    };
  }
  return {
    tokens: {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      accessTokenExpiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
    },
    error: null,
    errorDescription: null,
  };
}

export async function storeXboxLink(ctx: AuthContext, userId: string, tokens: XboxLinkTokens): Promise<string> {
  const xboxLive = await authenticateXboxLive(tokens.accessToken);
  const xsts = await authorizeXsts(xboxLive.token, XBOX_RELYING_PARTY);
  const xuid = xsts.xuid ?? xboxLive.xuid;
  if (!xuid) throw new Error('Xbox Live authentication did not return a user ID.');

  const data = {
    accountId: xuid,
    accessToken: await setTokenUtil(tokens.accessToken, ctx),
    refreshToken: (await setTokenUtil(tokens.refreshToken, ctx)) ?? null,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    scope: XBOX_SCOPE,
  };
  const existing = (await ctx.internalAdapter.findAccounts(userId)).find((account) => account.providerId === XBOX_PROVIDER_ID);
  if (existing) {
    await ctx.internalAdapter.updateAccount(existing.id, data);
  } else {
    await ctx.internalAdapter.createAccount({ userId, providerId: XBOX_PROVIDER_ID, ...data });
  }
  return xuid;
}
