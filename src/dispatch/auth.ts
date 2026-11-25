import { normalizeClientAuthentication } from '../lib/client-authentication';
import { CookieSessionStore } from '../lib/cookie-session';
import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { withCdnProfileAvatarUrls } from '../lib/profile-avatar';
import { withOAuthProxyState } from '../lib/oauth-proxy';
import { withAuth } from '../lib/request-auth';
import { assertTokenSessionActive } from '../lib/session-expiry';
import { TurnstileGate } from '../lib/turnstile';
import { resendVerificationForUnverifiedUser } from '../lib/verification-resend';

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
    const rejectedTurnstile = await new TurnstileGate(env, request).reject();
    if (rejectedTurnstile) return rejectedTurnstile;
    const resent = await resendVerificationForUnverifiedUser(env, request, pathname);
    if (resent) return resent;
    const cookieSession = request.method === 'GET' && pathname === '/api/auth/get-session' ? new CookieSessionStore(env, request) : null;
    const cached = await cookieSession?.get();
    if (cached) return cached;
    const authRequest = await normalizeClientAuthentication(env, request, pathname);
    const authResponse = await withOAuthProxyState(
      env,
      request.method,
      pathname,
      await withAuth(env, (auth) => auth.handler(authRequest))
    );
    if (pathname === '/api/auth/oauth2/token') await assertTokenSessionActive(env, authResponse);
    const response = await withCdnProfileAvatarUrls(env, pathname, authResponse);
    await cookieSession?.save(response);
    return response;
  }
}
