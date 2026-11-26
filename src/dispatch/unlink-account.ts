import type { AuthContext } from '@better-auth/core';
import { waitUntil } from 'cloudflare:workers';
import { z } from 'zod';
import { createDb } from '../db/create-db';
import { createAuth } from '../lib/auth';
import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { normalizeMinecraftUuid } from '../lib/minecraft-link-status';
import { AccountLinkDeleteRepository } from '../lib/redis/account-link-repositories';
import { MinecraftLinkStatusDeleteRepository } from '../lib/redis/minecraft-link-status-repositories';
import { withAuth } from '../lib/request-auth';

const unlinkBodySchema = z.object({ providerId: z.string().min(1), accountId: z.string().optional() });

export class UnlinkAccountDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.request.method === 'POST' && this.context.pathname === '/api/auth/unlink-account';
  }

  async handle(): Promise<Response> {
    const { env, request } = this.context;
    const body = unlinkBodySchema.safeParse(this.context.body);
    const target = body.success
      ? await withAuth(env, async (auth) => {
          const session = await auth.api.getSession({ headers: request.headers });
          if (!session) return null;
          const ctx = (await auth.$context) as unknown as AuthContext;
          const accounts = await ctx.internalAdapter.findAccounts(session.user.id);
          const account = accounts.find((entry) => entry.providerId === body.data.providerId && (!body.data.accountId || entry.accountId === body.data.accountId));
          if (!account || accounts.length < 2) return null;
          return { account, session: { id: session.session.id, userId: session.user.id, expiresAt: session.session.expiresAt } };
        })
      : null;
    if (!target) return withAuth(env, (auth) => auth.handler(request));

    await Promise.all([
      new AccountLinkDeleteRepository(env, target.session).delete(),
      target.account.providerId === 'minecraft'
        ? new MinecraftLinkStatusDeleteRepository(env).delete(normalizeMinecraftUuid(target.account.accountId))
        : undefined,
    ]);
    waitUntil(this.unlink(request));
    return Response.json({ status: true });
  }

  private async unlink(request: Request): Promise<void> {
    const db = createDb(this.context.env.HYPERDRIVE.connectionString);
    try {
      await (await createAuth(this.context.env, db)).handler(request);
    } catch (error) {
      console.error('Failed to unlink the account:', error);
    } finally {
      await db.$client.end();
    }
  }
}
