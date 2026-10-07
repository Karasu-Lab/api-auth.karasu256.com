import { createDb } from '@Hashibutogarasu/db/create-db';
import { waitUntil } from 'cloudflare:workers';
import { z } from 'zod';
import { createTestAuth } from '../lib/auth';

const postBodySchema = z.object({ label: z.string().min(1) });
const deleteBodySchema = z.object({ uid: z.string().min(1) });

/** Test-only endpoints are served only by the local worker, never by preview or production. */
function isEnabled(env: Env): boolean {
  return env.APP_ENV === 'local';
}

const notFound = () => Response.json({ error: 'not found' }, { status: 404 });

async function withTestAuth<T>(env: Env, fn: (auth: ReturnType<typeof createTestAuth>) => Promise<T>): Promise<T> {
  const db = createDb(env.DATABASE_URL);
  try {
    return await fn(createTestAuth(env, db));
  } finally {
    waitUntil(db.$client.end());
  }
}

/**
 * Creates a real better-auth test user with a working `credential`
 * (email/password) account and signs it in as a bridged `multiSession`
 * device session, through the test-only instance's `ctx.test.login`. Returns
 * the plaintext password and every cookie Playwright's `context.addCookies()`
 * needs to start a test already signed in.
 *
 * POST /api/test/accounts
 * Body: { label: string }
 */
export async function handleCreateTestAccount(env: Env, request: Request): Promise<Response> {
  if (!isEnabled(env)) return notFound();

  const parsed = postBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'label required' }, { status: 400 });

  const email = `e2e-${parsed.data.label}-${Date.now()}@example.test`;
  const password = crypto.randomUUID();

  return withTestAuth(env, async (testAuth) => {
    const ctx = await testAuth.$context;
    const user = await ctx.test.saveUser(ctx.test.createUser({ email, name: email }));

    const passwordHash = await ctx.password.hash(password);
    await ctx.internalAdapter.linkAccount({
      userId: user.id,
      providerId: 'credential',
      accountId: user.id,
      password: passwordHash,
    });

    const { token, cookies } = await ctx.test.login({ userId: user.id });
    return Response.json({ uid: user.id, email, password, sessionToken: token, cookies });
  });
}

/**
 * Deletes a test account created via `POST`; the schema's `onDelete: 'cascade'`
 * foreign keys remove its sessions and accounts.
 *
 * DELETE /api/test/accounts
 * Body: { uid: string }
 */
export async function handleDeleteTestAccount(env: Env, request: Request): Promise<Response> {
  if (!isEnabled(env)) return notFound();

  const parsed = deleteBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'uid required' }, { status: 400 });

  return withTestAuth(env, async (testAuth) => {
    const ctx = await testAuth.$context;
    await ctx.test.deleteUser(parsed.data.uid);
    return Response.json({ ok: true });
  });
}
