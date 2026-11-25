import { getAuthConfig } from '../config';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TOKEN_HEADER = 'cf-turnstile-response';

const GATED_ACTIONS: Record<string, string> = {
  '/api/auth/sign-in/email': 'sign-in',
  '/api/auth/sign-in/sso': 'sign-in',
  '/api/auth/sign-up/email': 'sign-up',
  '/api/auth/request-password-reset': 'password-reset',
};

interface SiteverifyResult {
  success?: boolean;
  action?: string;
  hostname?: string;
}

export async function rejectUnverifiedTurnstile(env: Env, request: Request): Promise<Response | null> {
  if (request.method !== 'POST') return null;
  const { pathname } = new URL(request.url);
  const expectedAction = GATED_ACTIONS[pathname];
  if (!expectedAction || env.APP_ENV === 'local') return null;

  const secret = env.CLOUDFLARE_TURNSTILE_SECRET;
  const { turnstileHostnames } = getAuthConfig(env);
  if (!secret || turnstileHostnames.length === 0) return null;

  const forbidden = () => Response.json({ code: 'bot_verification_failed' }, { status: 403 });

  const token = request.headers.get(TOKEN_HEADER);
  if (!token || token.length > 2048) return forbidden();

  const body = new URLSearchParams({ secret, response: token });
  const remoteIp = request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim();
  if (remoteIp) body.set('remoteip', remoteIp);

  let result: SiteverifyResult;
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
      body,
    });
    if (!response.ok) return forbidden();
    result = (await response.json()) as SiteverifyResult;
  } catch {
    return forbidden();
  }

  if (result.success !== true || result.action !== expectedAction || !result.hostname || !turnstileHostnames.includes(result.hostname)) {
    return forbidden();
  }
  return null;
}
