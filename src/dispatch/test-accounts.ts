import { createDb } from '@karasu-lab/db/create-db';
import { waitUntil } from 'cloudflare:workers';
import { z } from 'zod';
import { createTestAuth } from '../lib/auth';
import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { BadRequestError, NotFoundError } from '@karasu-lab/types/server';

const postBodySchema = z.object({ label: z.string().min(1) });
const deleteBodySchema = z.object({ uid: z.string().min(1) });

function isEnabled(env: Env): boolean {
  return env.APP_ENV === 'local';
}

async function withTestAuth<T>(env: Env, fn: (auth: ReturnType<typeof createTestAuth>) => Promise<T>): Promise<T> {
  const db = createDb(env.DATABASE_URL);
  try {
    return await fn(createTestAuth(env, db));
  } finally {
    waitUntil(db.$client.end());
  }
}

export class CreateTestAccountDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname === '/api/test/accounts' && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    const { env } = this.context;
    if (!isEnabled(env)) throw new NotFoundError('not found');

    const parsed = postBodySchema.safeParse(this.context.body);
    if (!parsed.success) throw new BadRequestError('label required');

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
}

export class DeleteTestAccountDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname === '/api/test/accounts' && this.context.request.method === 'DELETE';
  }

  async handle(): Promise<Response> {
    const { env } = this.context;
    if (!isEnabled(env)) throw new NotFoundError('not found');

    const parsed = deleteBodySchema.safeParse(this.context.body);
    if (!parsed.success) throw new BadRequestError('uid required');

    return withTestAuth(env, async (testAuth) => {
      const ctx = await testAuth.$context;
      await ctx.test.deleteUser(parsed.data.uid);
      return Response.json({ ok: true });
    });
  }
}
