import { HttpError, UnauthorizedError } from '@karasu-lab/types/server';
import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { withAuth } from '../lib/request-auth';
import { sendVerificationWithLimit } from '../lib/verification-resend';

export class ResendVerificationEmailDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname === '/api/email-verification/resend' && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    const { env, request } = this.context;
    const user = await withAuth(env, async (auth) => (await auth.api.getSession({ headers: request.headers }))?.user);
    if (!user) throw new UnauthorizedError();
    if (user.emailVerified) throw new HttpError(409, { code: 'EMAIL_ALREADY_VERIFIED' });

    if (!(await sendVerificationWithLimit(env, user.email.toLowerCase(), request))) {
      throw new HttpError(429, { code: 'VERIFICATION_EMAIL_RATE_LIMITED' });
    }
    return Response.json({ ok: true });
  }
}
