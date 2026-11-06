import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { withCdnProfileAvatarUrls } from '../lib/profile-avatar';
import { toHandlerRequest, withAuth } from '../lib/request-auth';
import { rejectUnverifiedTurnstile } from '../lib/turnstile';

export class AuthDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname.startsWith('/api/auth/');
  }

  async handle(): Promise<Response> {
    const { env, request, pathname, body } = this.context;
    const rejectedTurnstile = await rejectUnverifiedTurnstile(env, request);
    if (rejectedTurnstile) return rejectedTurnstile;
    const response = await withAuth(env, (auth) => auth.handler(toHandlerRequest(request, body)));
    return withCdnProfileAvatarUrls(env, pathname, response);
  }
}
