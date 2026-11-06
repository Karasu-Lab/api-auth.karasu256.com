import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { withCdnProfileAvatarUrls } from '../lib/profile-avatar';
import { withAuth } from '../lib/request-auth';
import { rejectUnverifiedTurnstile } from '../lib/turnstile';

export class RotateSecretDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname === '/api/auth/oauth2/client/rotate-secret' && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    return this.context.fallback(this.context.request);
  }
}

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
    const response = await withAuth(env, (auth) => auth.handler(request));
    return withCdnProfileAvatarUrls(env, pathname, response);
  }
}
