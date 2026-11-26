import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';

const VERIFY_PATH = '/one-time-token/verify';
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

function encodeBase64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sign(secret: string, value: string, state: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return encodeBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${value}.${state}`))));
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function requireState(raw: unknown): string {
  if (typeof raw !== 'string' || !STATE_PATTERN.test(raw)) throw new APIError('BAD_REQUEST', { message: 'invalid_state' });
  return raw;
}

export function oneTimeTokenStateOptions(env: Env) {
  return {
    expiresIn: 1,
    generateToken: async (_session: unknown, ctx: { query?: Record<string, unknown> }) => {
      const state = requireState(ctx.query?.state);
      const value = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
      return `${value}.${await sign(env.BETTER_AUTH_SECRET, value, state)}`;
    },
  };
}

export function oneTimeTokenStatePlugin(env: Env) {
  return {
    id: 'one-time-token-state',
    hooks: {
      before: [
        {
          matcher: (context: { path?: string }) => context.path === VERIFY_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const state = requireState(ctx.query?.state);
            const token = (ctx.body as { token?: unknown } | undefined)?.token;
            const [value, signature] = typeof token === 'string' ? token.split('.') : [];
            if (!value || !signature || !timingSafeEqual(signature, await sign(env.BETTER_AUTH_SECRET, value, state))) {
              throw new APIError('BAD_REQUEST', { message: 'invalid_state' });
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
