import { createDb } from '@karasu-lab/db/create-db';
import { sessions } from '@karasu-lab/db/schema';
import { waitUntil } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { BadRequestError, UnauthorizedError } from '@karasu-lab/types/server';
import { withAuth } from '../lib/request-auth';
import { presignUploadUrl } from '../lib/storage';

const sessionTokenBodySchema = z.object({ accessToken: z.string().min(1) });
const iconUploadUrlBodySchema = z.object({ userId: z.string().min(1), contentType: z.string().min(1) });
const userinfoSchema = z.object({ sub: z.string() });
const sessionClaimsSchema = z.object({ sid: z.string() });

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

    const userinfo = await withAuth(env, (auth) =>
      auth.handler(
        new Request(`${env.BETTER_AUTH_URL}/api/auth/oauth2/userinfo`, {
          headers: { authorization: `Bearer ${accessToken}` },
        })
      )
    );
    if (!userinfo.ok) throw new UnauthorizedError();
    const parsedUserinfo = userinfoSchema.safeParse(await userinfo.json().catch(() => null));
    const sub = parsedUserinfo.success ? parsedUserinfo.data.sub : null;

    let sessionId: string | null = null;
    try {
      const claims = sessionClaimsSchema.safeParse(decodeJwt(accessToken));
      sessionId = claims.success ? claims.data.sid : null;
    } catch {
      sessionId = null;
    }
    if (!sub || !sessionId) throw new UnauthorizedError();

    const db = createDb(env.DATABASE_URL);
    try {
      const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      const session = rows[0];
      if (!session || session.userId !== sub || session.expiresAt.getTime() <= Date.now()) throw new UnauthorizedError();

      const token = await withAuth(env, async (auth) => {
        const authContext = await auth.$context;
        const found = await authContext.internalAdapter.findSession(session.token);
        if (!found || found.session.id !== session.id || found.user.id !== sub) return null;
        if (found.session.expiresAt.getTime() <= Date.now()) return null;
        const signed = await auth.api.signJWT({
          body: { payload: { ...found.user, iat: Math.floor(Date.now() / 1000), sub: found.user.id } },
        });
        return signed.token;
      }).catch(() => null);
      if (!token) throw new UnauthorizedError();
      return Response.json({ token });
    } finally {
      waitUntil(db.$client.end());
    }
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
