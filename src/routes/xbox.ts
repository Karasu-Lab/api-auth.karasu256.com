import type { AuthContext } from '@better-auth/core';
import {
  buildXboxAuthorizeUrl,
  createXboxLinkState,
  exchangeXboxLinkCode,
  storeXboxLink,
  verifyXboxLinkState,
  XboxLinkError,
} from '../lib/xbox-link';
import { withAuth } from '../lib/request-auth';
import type { Auth } from '../lib/auth';

function linkingUrl(env: Env): string {
  return `${env.ACCOUNTS_URL.replace(/\/+$/, '')}/settings/linking`;
}

function appCallbackUrl(env: Env): string {
  return `${env.ACCOUNTS_URL.replace(/\/+$/, '')}/auth/app/callback`;
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

export async function handleXboxAppLink(env: Env, request: Request): Promise<Response> {
  if (!env.MICROSOFT_CLIENT_ID) return Response.json({ error: 'xbox_link_not_configured' }, { status: 503 });
  const url = await withAuth(env, async (auth: Auth) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return null;
    const state = await createXboxLinkState(env.BETTER_AUTH_SECRET, session.user.id, true);
    return buildXboxAuthorizeUrl(env.MICROSOFT_CLIENT_ID!, callbackUrl(env), state);
  });
  if (!url) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  return Response.json({ url });
}

export async function handleXboxCallback(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const linkState = state ? await verifyXboxLinkState(env.BETTER_AUTH_SECRET, state) : null;
  const destination = new URL(linkState?.app ? appCallbackUrl(env) : linkingUrl(env));
  const fail = (error: string, errorDescription?: string | null) => {
    destination.searchParams.set('error', error);
    if (errorDescription) destination.searchParams.set('error_description', errorDescription);
    return Response.redirect(destination.toString(), 302);
  };

  const authorizeError = url.searchParams.get('error');
  if (authorizeError) return fail(authorizeError, url.searchParams.get('error_description'));

  const code = url.searchParams.get('code');
  if (!code || !state) return fail('xbox_link_missing_code', 'Microsoft did not return an authorization code.');
  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET) {
    return fail('xbox_link_not_configured', 'The Microsoft client credentials are not configured on the server.');
  }

  try {
    await withAuth(env, async (auth: Auth) => {
      if (!linkState) throw new XboxLinkError('xbox_link_state_invalid', 'The link state was invalid or expired.');
      if (!linkState.app) {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session || session.user.id !== linkState.userId) {
          throw new XboxLinkError('xbox_link_session_mismatch', 'The session does not match the user who started the Xbox link.');
        }
      }

      const exchange = await exchangeXboxLinkCode(code, callbackUrl(env), env.MICROSOFT_CLIENT_ID!, env.MICROSOFT_CLIENT_SECRET!);
      if (!exchange.tokens) throw new XboxLinkError(exchange.error ?? 'xbox_token_exchange_failed', exchange.errorDescription);

      const ctx = (await auth.$context) as unknown as AuthContext;
      try {
        await storeXboxLink(ctx, linkState.userId, exchange.tokens);
      } catch (error) {
        throw new XboxLinkError('xbox_live_rejected', null, error);
      }
    });
  } catch (error) {
    if (error instanceof XboxLinkError) return fail(error.error, error.errorDescription);
    throw error;
  }

  destination.searchParams.set('linked', 'Xbox');
  return Response.redirect(destination.toString(), 302);
}
