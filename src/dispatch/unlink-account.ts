import type { AuthContext } from '@better-auth/core';
import { z } from 'zod';
import { createDb } from '../db/create-db';
import { createAuth } from '../lib/auth';
import { deleteProviderAvatar, storedAvatarProviderIds } from '../lib/avatar-api';
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
    if (!body.success || !target) return withAuth(env, (auth) => auth.handler(request));

    const headers = new Headers(request.headers);
    headers.delete('content-length');
    headers.set('content-type', 'application/json');
    const forwarded = new Request(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify({ providerId: body.data.providerId, accountId: target.account.id }),
    });
    const response = await this.unlink(forwarded);
    if (!response.ok) {
      const text = await response.clone().text().catch(() => '');
      console.error(`Unlinking ${body.data.providerId} failed with ${response.status}: ${text}`);
      let record: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(text) as unknown;
        if (typeof parsed === 'object' && parsed !== null) record = parsed as Record<string, unknown>;
      } catch {
        record = {};
      }
      const code = [record.code, record.error].find((value): value is string => typeof value === 'string');
      const message = [record.reason, record.message, record.error_description].find((value): value is string => typeof value === 'string');
      return Response.json(
        {
          error: code ?? 'account_unlink_failed',
          reason: message ?? `Authentication provider rejected the unlink request (${response.status}).`,
        },
        { status: response.status },
      );
    }

    try {
      await Promise.all([
        new AccountLinkDeleteRepository(env, target.session).delete(),
        ...(target.account.providerId === 'minecraft'
          ? [new MinecraftLinkStatusDeleteRepository(env).delete(normalizeMinecraftUuid(target.account.accountId))]
          : storedAvatarProviderIds(target.account.providerId).map((providerId) =>
              deleteProviderAvatar(env, target.session.userId, providerId)
            )),
      ]);
    } catch (error) {
      console.error('Account was unlinked but cached link state could not be cleared:', error);
      return Response.json({
        error: 'account_unlink_cleanup_failed',
        reason: 'The account was unlinked, but cached link state could not be cleared.',
      }, { status: 500 });
    }
    return Response.json({ status: true });
  }

  private async unlink(request: Request): Promise<Response> {
    const db = createDb(this.context.env.HYPERDRIVE.connectionString);
    try {
      return await (await createAuth(this.context.env, db)).handler(request);
    } finally {
      await db.$client.end();
    }
  }
}
