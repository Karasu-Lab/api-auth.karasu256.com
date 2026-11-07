import { createDb } from '@karasu-lab/db/create-db';
import { waitUntil } from 'cloudflare:workers';
import { getAuthConfig } from '../config';
import { createLinkState, verifyLinkState } from '../lib/link-state';
import { withAuth } from '../lib/request-auth';
import { exchangeSigningKeyAuthorizationCode, storeSigningKeyAuthorization } from '../lib/signing-key';

const STATE_KIND = 'signing-key-authorization';
const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const SIGNING_KEY_SCOPE = 'admin:ssh_signing_key';

function callbackUrl(env: Env): string {
  return `${env.BETTER_AUTH_URL.replace(/\/+$/, '')}/api/signing-keys/callback`;
}

function isTrustedReturnTo(env: Env, returnTo: string): boolean {
  const { trustedOrigins } = getAuthConfig(env);
  return trustedOrigins.some((origin) => returnTo === origin || returnTo.startsWith(`${origin}/`));
}

export async function handleSigningKeyAuthorize(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const returnTo = url.searchParams.get('returnTo');
  return withAuth(env, async (auth) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      const next = encodeURIComponent(url.toString());
      return Response.redirect(`${env.AUTH_UI_URL.replace(/\/+$/, '')}/sign-in?next=${next}`, 302);
    }
    if (!returnTo || !isTrustedReturnTo(env, returnTo)) {
      return Response.json({ error: 'Bad Request' }, { status: 400 });
    }
    if (!env.GH_OATH_CLIENT_ID) return Response.json({ error: 'github_not_configured' }, { status: 503 });
    const state = await createLinkState(env.BETTER_AUTH_SECRET, {
      kind: STATE_KIND,
      userId: session.user.id,
      returnTo,
    });
    const destination = new URL(GITHUB_AUTHORIZE_URL);
    destination.searchParams.set('client_id', env.GH_OATH_CLIENT_ID);
    destination.searchParams.set('redirect_uri', callbackUrl(env));
    destination.searchParams.set('scope', SIGNING_KEY_SCOPE);
    destination.searchParams.set('state', state);
    return Response.redirect(destination.toString(), 302);
  });
}

export async function handleSigningKeyCallback(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const fallback = `${env.ACCOUNTS_URL.replace(/\/+$/, '')}/settings`;
  const state = url.searchParams.get('state');
  if (!state) return Response.redirect(`${fallback}?error=signing_key_state_missing`, 302);
  const payload = await verifyLinkState(env.BETTER_AUTH_SECRET, state);
  if (!payload || payload.kind !== STATE_KIND) {
    return Response.redirect(`${fallback}?error=signing_key_state_invalid`, 302);
  }
  const destination = new URL(payload.returnTo);
  const fail = (error: string) => {
    destination.searchParams.set('error', error);
    return Response.redirect(destination.toString(), 302);
  };
  const authorizeError = url.searchParams.get('error');
  if (authorizeError) return fail(authorizeError);
  const code = url.searchParams.get('code');
  if (!code) return fail('signing_key_code_missing');

  try {
    const tokens = await exchangeSigningKeyAuthorizationCode(env, code, callbackUrl(env));
    if (!tokens) return fail('signing_key_exchange_failed');
    await withAuth(env, async (auth) => {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session || session.user.id !== payload.userId) throw new Error('session_mismatch');
      const db = createDb(env.DATABASE_URL);
      try {
        await storeSigningKeyAuthorization(auth, db, session.user.id, tokens);
      } finally {
        waitUntil(db.$client.end());
      }
    });
  } catch {
    return fail('signing_key_authorization_failed');
  }
  destination.searchParams.set('signingKey', 'authorized');
  return Response.redirect(destination.toString(), 302);
}
