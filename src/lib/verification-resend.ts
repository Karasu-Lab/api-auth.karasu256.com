import { waitUntil } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createDb } from '../db/create-db';
import { users } from '../db/schema';
import { withAuth } from './request-auth';

async function consume(kv: KVNamespace, key: string, limit: number): Promise<boolean> {
  const used = Number(await kv.get(key)) || 0;
  if (used >= limit) return false;
  await kv.put(key, String(used + 1), { expirationTtl: 60 * 60 });
  return true;
}

export async function resendVerificationForUnverifiedUser(env: Env, request: Request, pathname: string): Promise<Response | null> {
  if (request.method !== 'POST' || pathname !== '/api/auth/sign-up/email') return null;
  const body = z.object({ email: z.email() }).safeParse(
    await request
      .clone()
      .json()
      .catch(() => null)
  );
  if (!body.success) return null;
  const email = body.data.email.toLowerCase();

  const db = createDb(env.HYPERDRIVE.connectionString);
  let unverified: boolean;
  try {
    const [user] = await db.select({ emailVerified: users.emailVerified }).from(users).where(eq(users.email, email));
    unverified = user !== undefined && !user.emailVerified;
  } finally {
    waitUntil(db.$client.end());
  }
  if (!unverified) return null;

  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const allowed =
    (await consume(env.VERIFICATION_RESEND_KV, `resend:email:${email}`, 3)) && (await consume(env.VERIFICATION_RESEND_KV, `resend:ip:${ip}`, 10));
  if (!allowed) {
    return Response.json({ code: 'VERIFICATION_EMAIL_RATE_LIMITED', message: 'Too many verification emails were requested.' }, { status: 429 });
  }

  await withAuth(env, (auth) => auth.api.sendVerificationEmail({ body: { email, callbackURL: `${env.AUTH_UI_URL}/email/verify/complete` } }));
  return Response.json({ code: 'VERIFICATION_EMAIL_RESENT', message: 'The verification email was sent again.' }, { status: 409 });
}
