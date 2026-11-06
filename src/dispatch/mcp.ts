import { createDb } from '@karasu-lab/db/create-db';
import { sessions } from '@karasu-lab/db/schema';
import { waitUntil } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { BadRequestError, UnauthorizedError } from '../lib/errors';
import { withAuth } from '../lib/request-auth';
import { presignUploadUrl } from '../lib/storage';

export class McpSessionTokenDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname === '/api/internal/mcp/session-token' && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    const { env, request } = this.context;
    const body = (await request.json().catch(() => null)) as { accessToken?: unknown } | null;
    const accessToken = typeof body?.accessToken === 'string' ? body.accessToken : null;
    if (!accessToken) throw new BadRequestError('invalid_request');

    const userinfo = await withAuth(env, (auth) =>
      auth.handler(
        new Request(`${env.BETTER_AUTH_URL}/api/auth/oauth2/userinfo`, {
          headers: { authorization: `Bearer ${accessToken}` },
        })
      )
    );
    if (!userinfo.ok) throw new UnauthorizedError();
    const { sub } = (await userinfo.json().catch(() => ({}))) as { sub?: string };

    let sessionId: string | null = null;
    try {
      const payload = decodeJwt(accessToken);
      sessionId = typeof payload.sid === 'string' ? payload.sid : null;
    } catch {
      sessionId = null;
    }
    if (!sub || !sessionId) throw new UnauthorizedError();

    const db = createDb(env.DATABASE_URL);
    try {
      const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      const session = rows[0];
      if (!session || session.userId !== sub || session.expiresAt.getTime() <= Date.now()) throw new UnauthorizedError();

      const { token } = await withAuth(env, (auth) =>
        auth.api.getToken({ headers: new Headers({ cookie: `better-auth.session_token=${session.token}` }) })
      );
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
    const { env, request } = this.context;
    const body = (await request.json().catch(() => null)) as { userId?: unknown; contentType?: unknown } | null;
    const userId = typeof body?.userId === 'string' ? body.userId : null;
    const contentType = typeof body?.contentType === 'string' ? body.contentType : null;
    if (!userId || !contentType) throw new BadRequestError('invalid_request');

    const path = `u/profiles/${userId}/avatar.png`;
    const uploadUrl = presignUploadUrl(env, path, contentType);
    return Response.json({ uploadUrl, path });
  }
}
