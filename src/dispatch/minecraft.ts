import type { AuthContext } from '@better-auth/core';
import { waitUntil } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { BadRequestError, HttpError, RateLimitedError } from '@karasu-lab/types/server';
import { createDb } from '../db/create-db';
import * as schema from '../db/schema';
import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { checkMinecraftStatusRateLimit } from '../lib/minecraft-status-rate-limit';
import { MinecraftLinkStatusGetRepository, MinecraftLinkStatusSetRepository } from '../lib/redis/minecraft-link-status-repositories';
import { withAuth } from '../lib/request-auth';

const LINK_PATH = /^\/api\/internal\/users\/([^/]+)\/minecraft-link$/;

const linkBodySchema = z.object({
  uuid: z.string().regex(/^[0-9a-f]{32}$/i),
});

export class LinkMinecraftDispatch implements Dispatchable {
  private context: DispatchContext;
  private userId: string | null = null;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    if (this.context.request.method !== 'POST') return false;
    const match = LINK_PATH.exec(this.context.pathname);
    if (!match) return false;
    this.userId = decodeURIComponent(match[1]);
    return true;
  }

  async handle(): Promise<Response> {
    const userId = this.userId as string;
    const parsed = linkBodySchema.safeParse(this.context.body);
    if (!parsed.success) throw new BadRequestError();
    const uuid = parsed.data.uuid.toLowerCase();

    return withAuth(this.context.env, async (auth) => {
      const ctx = (await auth.$context) as unknown as AuthContext;
      const owner = await ctx.adapter.findOne<{ userId: string }>({
        model: 'account',
        where: [
          { field: 'providerId', value: 'minecraft' },
          { field: 'accountId', value: uuid },
        ],
      });
      if (owner && owner.userId !== userId) throw new HttpError(409, { error: 'Conflict' });

      const statusRepository = new MinecraftLinkStatusSetRepository(this.context.env);
      const existing = (await ctx.internalAdapter.findAccounts(userId)).find((account) => account.providerId === 'minecraft');
      if (existing) {
        await ctx.internalAdapter.updateAccount(existing.id, { accountId: uuid });
        if (existing.accountId !== uuid) await statusRepository.set(existing.accountId, { linked: false });
      } else {
        await ctx.internalAdapter.createAccount({ userId, providerId: 'minecraft', accountId: uuid });
      }
      await statusRepository.set(uuid, { linked: true });
      return Response.json({ linked: true, uuid });
    });
  }
}

export class MinecraftVerifyStatusDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname === '/api/minecraft/verify/status' && this.context.request.method === 'GET';
  }

  async handle(): Promise<Response> {
    const { env, request } = this.context;
    const rateLimit = await checkMinecraftStatusRateLimit(env, request.headers.get('CF-Connecting-IP') ?? 'unknown');
    if (!rateLimit.allowed) throw new RateLimitedError(rateLimit.retryAfterSeconds);

    const uuid = z
      .string()
      .transform((value) => value.replaceAll('-', '').toLowerCase())
      .pipe(z.string().regex(/^[0-9a-f]{32}$/))
      .safeParse(new URL(request.url).searchParams.get('uuid'));
    if (!uuid.success) throw new BadRequestError();

    const cached = await new MinecraftLinkStatusGetRepository(env).get(uuid.data);
    if (cached) return Response.json({ linked: cached.linked });

    const db = createDb(env.DATABASE_URL);
    let linked: boolean;
    try {
      const [account] = await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(and(eq(schema.accounts.providerId, 'minecraft'), eq(schema.accounts.accountId, uuid.data)))
        .limit(1);
      linked = Boolean(account);
    } finally {
      waitUntil(db.$client.end());
    }
    await new MinecraftLinkStatusSetRepository(env).set(uuid.data, { linked });
    return Response.json({ linked });
  }
}
