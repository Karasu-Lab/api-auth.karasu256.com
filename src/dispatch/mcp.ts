import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { z } from 'zod';
import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { BadRequestError, UnauthorizedError } from '@karasu-lab/types/server';
import { withAuth } from '../lib/request-auth';
import { isSessionExpired } from '../lib/session-expiry';
import { presignUploadUrl } from '../lib/storage';

const sessionTokenBodySchema = z.object({ accessToken: z.string().min(1) });
const iconUploadUrlBodySchema = z.object({ userId: z.string().min(1), contentType: z.string().min(1) });
const accessTokenClaimsSchema = z.object({
  sub: z.string().min(1),
  sid: z.string().optional(),
  email: z.string().nullish(),
  name: z.string().nullish(),
  picture: z.string().nullish(),
});

export class McpSessionTokenDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname === '/api/internal/mcp/session-token' && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    const { env } = this.context;
    const parsedBody = sessionTokenBodySchema.safeParse(this.context.body);
    if (!parsedBody.success) throw new BadRequestError('invalid_request');
    const accessToken = parsedBody.data.accessToken;

    const token = await withAuth(env, async (auth) => {
      const jwks = (await auth.api.getJwks()) as JSONWebKeySet;
      const { payload } = await jwtVerify(accessToken, createLocalJWKSet(jwks), {
        issuer: `${env.BETTER_AUTH_URL}/api/auth`,
        audience: env.MCP_URL,
      });
      const claims = accessTokenClaimsSchema.parse(payload);
      if (claims.sid && (await isSessionExpired(env, claims.sid))) throw new UnauthorizedError();
      const signed = await auth.api.signJWT({
        body: {
          payload: {
            id: claims.sub,
            email: claims.email ?? null,
            name: claims.name ?? null,
            image: claims.picture ?? null,
            iat: Math.floor(Date.now() / 1000),
            sub: claims.sub,
          },
        },
      });
      return signed.token;
    }).catch(() => null);
    if (!token) throw new UnauthorizedError();
    return Response.json({ token });
  }
}

export class McpIconUploadUrlDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname === '/api/internal/mcp/icon-upload-url' && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    const { env } = this.context;
    const parsedBody = iconUploadUrlBodySchema.safeParse(this.context.body);
    if (!parsedBody.success) throw new BadRequestError('invalid_request');

    const path = `u/profiles/${parsedBody.data.userId}/avatar.png`;
    const uploadUrl = presignUploadUrl(env, path, parsedBody.data.contentType);
    return Response.json({ uploadUrl, path });
  }
}
