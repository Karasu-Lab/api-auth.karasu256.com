import { createDb } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import { waitUntil } from 'cloudflare:workers';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { BadRequestError, NotFoundError, RateLimitedError } from '../lib/errors';
import { checkSignInLookupRateLimit } from '../lib/rate-limit';

export class SignInLookupDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname === '/api/sign-in/lookup' && this.context.request.method === 'GET';
  }

  async handle(): Promise<Response> {
    const { env, request } = this.context;
    const rateLimit = await checkSignInLookupRateLimit(env, request.headers.get('CF-Connecting-IP') ?? 'unknown');
    if (!rateLimit.allowed) throw new RateLimitedError(rateLimit.retryAfterSeconds);

    const email = new URL(request.url).searchParams.get('email')?.trim().toLowerCase() ?? '';
    if (!email.includes('@')) throw new BadRequestError('email required');

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

      if (!user && !provider) throw new NotFoundError({ code: 'account_not_found' });

      return Response.json({ sso: Boolean(provider), hasPassword, hasPasskey });
    } finally {
      waitUntil(db.$client.end());
    }
  }
}
