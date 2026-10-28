import { createDb } from '@Hashibutogarasu/db/create-db';
import * as schema from '@Hashibutogarasu/db/schema';
import { waitUntil } from 'cloudflare:workers';
import { and, eq, isNotNull } from 'drizzle-orm';

/**
 * Answers the one question the SSO site's two-step sign-in form has to ask
 * before it can route a work email address: does an account exist for it,
 * does its domain have an SSO provider registered, and can it sign in with
 * a password at all. Only booleans are returned; the address itself and
 * every account detail stay server-side.
 *
 * GET /api/sign-in/lookup?email=<address>
 * Response: { exists: boolean, sso: boolean, hasPassword: boolean }
 */
export async function handleSignInLookup(env: Env, request: Request): Promise<Response> {
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
    if (user) {
      const [credential] = await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(and(eq(schema.accounts.userId, user.id), eq(schema.accounts.providerId, 'credential'), isNotNull(schema.accounts.password)))
        .limit(1);
      hasPassword = Boolean(credential);
    }

    return Response.json({ exists: Boolean(user), sso: Boolean(provider), hasPassword });
  } finally {
    waitUntil(db.$client.end());
  }
}
