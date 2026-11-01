import type { AuthContext } from '@better-auth/core';
import { buildXboxAuthorizeUrl, createXboxLinkState, exchangeXboxLinkCode, storeXboxLink, verifyXboxLinkState } from '../lib/xbox-link';
import { withAuth } from '../lib/request-auth';
import type { Auth } from '../lib/auth';

function linkingUrl(env: Env): string {
  return `${env.ACCOUNTS_URL.replace(/\/+$/, '')}/settings/linking`;
}

function callbackUrl(env: Env): string {
  return `${env.BETTER_AUTH_URL.replace(/\/+$/, '')}/api/xbox/callback`;
}

export async function handleXboxLink(env: Env, request: Request): Promise<Response> {
  const destination = await withAuth(env, async (auth: Auth) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      const next = encodeURIComponent(`${env.BETTER_AUTH_URL.replace(/\/+$/, '')}/api/xbox/link`);
      return `${env.AUTH_UI_URL.replace(/\/+$/, '')}/sign-in?next=${next}`;
    }
    if (!env.MICROSOFT_CLIENT_ID) return linkingUrl(env);
    const state = await createXboxLinkState(env.BETTER_AUTH_SECRET, session.user.id);
    return buildXboxAuthorizeUrl(env.MICROSOFT_CLIENT_ID, callbackUrl(env), state);
  });
  return Response.redirect(destination, 302);
}

export async function handleXboxCallback(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  const succeeded =
    code && state && env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET
      ? await withAuth(env, async (auth: Auth) => {
          const stateUserId = await verifyXboxLinkState(env.BETTER_AUTH_SECRET, state);
          if (!stateUserId) return false;
          const session = await auth.api.getSession({ headers: request.headers });
          if (!session || session.user.id !== stateUserId) return false;

          const tokens = await exchangeXboxLinkCode(code, callbackUrl(env), env.MICROSOFT_CLIENT_ID!, env.MICROSOFT_CLIENT_SECRET!);
          if (!tokens) return false;

          const ctx = (await auth.$context) as unknown as AuthContext;
          return storeXboxLink(ctx, session.user.id, tokens);
        }).catch(() => false)
      : false;

  const destination = new URL(linkingUrl(env));
  if (!succeeded) destination.searchParams.set('error', 'xbox_link_failed');
  return Response.redirect(destination.toString(), 302);
}
