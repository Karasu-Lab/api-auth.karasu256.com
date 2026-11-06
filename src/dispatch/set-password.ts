import { APIError } from 'better-auth/api';
import { z } from 'zod';
import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { BadRequestError } from '../lib/errors';
import { withAuth } from '../lib/request-auth';

const bodySchema = z.object({ newPassword: z.string().min(1) });

export class SetPasswordDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname === '/api/auth/set-password';
  }

  async handle(): Promise<Response> {
    const { env, request } = this.context;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError();

    try {
      await withAuth(env, (auth) => auth.api.setPassword({ body: { newPassword: parsed.data.newPassword }, headers: request.headers }));
      return Response.json({ ok: true });
    } catch (err) {
      throw new BadRequestError(err instanceof APIError ? err.message : 'Failed to set password');
    }
  }
}
