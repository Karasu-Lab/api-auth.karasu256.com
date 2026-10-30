import { createDb } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import { waitUntil } from 'cloudflare:workers';
import { and, eq, isNotNull } from 'drizzle-orm';
import { checkSignInLookupRateLimit } from '../lib/rate-limit';

/**
 * Answers the one question the SSO site's two-step sign-in form has to ask
 * before it can route a work email address: does an account exist for it,
 * does its domain have an SSO provider registered, and can it sign in with
 * a password or a passkey. The address itself and every account detail stay
 * server-side.
 *
 * The answer is carried by the status code, not by a field:
 * - 200 with { sso, hasPassword, hasPasskey }: the address can sign in,
 *   either because an account exists or because its domain has an SSO
 *   provider (whose IdP provisions accounts on first sign-in).
 * - 404: no account and no SSO provider for the address.
 * - 429 with { code: 'rate_limited', retryAfterSeconds }: the caller hit
 *   the limit of 10 requests per minute (see `lib/rate-limit.ts`); the
 *   `Retry-After` header carries the same wait in seconds.
 *
 * GET /api/sign-in/lookup?email=<address>
 */
export async function handleSignInLookup(env: Env, request: Request): Promise<Response> {
  const rateLimit = await checkSignInLookupRateLimit(env, request.headers.get('CF-Connecting-IP') ?? 'unknown');
  if (!rateLimit.allowed) {
    return Response.json(
      { code: 'rate_limited', retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) } }
    );
  }

  const email = new URL(request.url).searchParams.get('email')?.trim().toLowerCase() ?? '';
  if (!email.includes('@')) return Response.json({ error: 'email required' }, { status: 400 });

  const db = createDb(env.DATABASE_URL);
  try {
    const domain = email.slice(email.indexOf('@') + 1);

    const [provider] = await db
      .select({ id: schema.ssoProviders.id })
      .from(schema.ssoProviders)
      .where(eq(schema.ssoProviders.domain, domain))
      .limit(1);

    const [user] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);

    let hasPassword = false;
    let hasPasskey = false;
    if (user) {
      const [credential] = await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(and(eq(schema.accounts.userId, user.id), eq(schema.accounts.providerId, 'credential'), isNotNull(schema.accounts.password)))
        .limit(1);
      hasPassword = Boolean(credential);

      const [passkey] = await db.select({ id: schema.passkeys.id }).from(schema.passkeys).where(eq(schema.passkeys.userId, user.id)).limit(1);
      hasPasskey = Boolean(passkey);
    }

    if (!user && !provider) return Response.json({ code: 'account_not_found' }, { status: 404 });

    return Response.json({ sso: Boolean(provider), hasPassword, hasPasskey });
  } finally {
    waitUntil(db.$client.end());
  }
}
