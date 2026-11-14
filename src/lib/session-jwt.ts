import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { getJwtToken, type JwtOptions } from 'better-auth/plugins/jwt';
import { SessionJwtCreateRepository, SessionJwtGetRepository } from './redis/session-jwt-repositories';

export async function cachedSessionJwt(env: Env, sessionId: string, sign: () => Promise<string>): Promise<string> {
  const cached = await new SessionJwtGetRepository(env).get(sessionId);
  if (cached) return cached;
  const token = await sign();
  await new SessionJwtCreateRepository(env).create(sessionId, token, 10 * 60);
  return token;
}

export function sessionJwtHeaderPlugin(env: Env, jwtOptions: JwtOptions) {
  return {
    id: 'session-jwt-header',
    hooks: {
      after: [
        {
          matcher: (context) => context.path === '/get-session',
          handler: createAuthMiddleware(async (ctx) => {
            const session = ctx.context.session || ctx.context.newSession;
            if (!session?.session) return;
            const token = await cachedSessionJwt(env, session.session.id, () => getJwtToken(ctx, jwtOptions));
            const exposed = new Set(
              (ctx.context.responseHeaders?.get('access-control-expose-headers') ?? '')
                .split(',')
                .map((header) => header.trim())
                .filter(Boolean)
            );
            exposed.add('set-auth-jwt');
            ctx.setHeader('set-auth-jwt', token);
            ctx.setHeader('Access-Control-Expose-Headers', Array.from(exposed).join(', '));
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
