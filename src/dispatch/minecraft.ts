import type { AuthContext } from '@better-auth/core';
import { z } from 'zod';
import { BadRequestError, HttpError } from '@karasu-lab/types/server';
import type { Dispatchable, DispatchContext } from '../lib/dispatch';
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

      const existing = (await ctx.internalAdapter.findAccounts(userId)).find((account) => account.providerId === 'minecraft');
      if (existing) {
        await ctx.internalAdapter.updateAccount(existing.id, { accountId: uuid });
      } else {
        await ctx.internalAdapter.createAccount({ userId, providerId: 'minecraft', accountId: uuid });
      }
      return Response.json({ linked: true, uuid });
    });
  }
}
