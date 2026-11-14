import { CookieSessionStore } from '../lib/cookie-session';
import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { withCdnProfileAvatarUrls } from '../lib/profile-avatar';
import { withAuth } from '../lib/request-auth';
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
    const { env, request, pathname } = this.context;
    const rejectedTurnstile = await rejectUnverifiedTurnstile(env, request);
    if (rejectedTurnstile) return rejectedTurnstile;
    const cookieSession = request.method === 'GET' && pathname === '/api/auth/get-session' ? new CookieSessionStore(env, request) : null;
    const cached = await cookieSession?.get();
    if (cached) return cached;
    const response = await withCdnProfileAvatarUrls(env, pathname, await withAuth(env, (auth) => auth.handler(request)));
    await cookieSession?.save(response);
    return response;
  }
}
