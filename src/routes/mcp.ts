import { createDb } from '@karasu-lab/db/create-db';
import { sessions } from '@karasu-lab/db/schema';
import { waitUntil } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { withAuth } from '../lib/request-auth';
import { presignUploadUrl } from '../lib/storage';

const unauthorized = () => Response.json({ error: 'Unauthorized' }, { status: 401 });

export async function handleMcpSessionToken(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { accessToken?: unknown } | null;
  const accessToken = typeof body?.accessToken === 'string' ? body.accessToken : null;
  if (!accessToken) return Response.json({ error: 'invalid_request' }, { status: 400 });

  const userinfo = await withAuth(env, (auth) =>
    auth.handler(
      new Request(`${env.BETTER_AUTH_URL}/api/auth/oauth2/userinfo`, {
        headers: { authorization: `Bearer ${accessToken}` },
      })
    )
  );
  if (!userinfo.ok) return unauthorized();
  const { sub } = (await userinfo.json().catch(() => ({}))) as { sub?: string };

  let sessionId: string | null = null;
  try {
    const payload = decodeJwt(accessToken);
    sessionId = typeof payload.sid === 'string' ? payload.sid : null;
  } catch {
    sessionId = null;
  }
  if (!sub || !sessionId) return unauthorized();

  const db = createDb(env.DATABASE_URL);
  try {
    const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    const session = rows[0];
    if (!session || session.userId !== sub || session.expiresAt.getTime() <= Date.now()) return unauthorized();

    const { token } = await withAuth(env, (auth) =>
      auth.api.getToken({ headers: new Headers({ cookie: `better-auth.session_token=${session.token}` }) })
    );
    if (!token) return unauthorized();
    return Response.json({ token });
  } finally {
    waitUntil(db.$client.end());
  }
}

export async function handleMcpIconUploadUrl(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { userId?: unknown; contentType?: unknown } | null;
  const userId = typeof body?.userId === 'string' ? body.userId : null;
  const contentType = typeof body?.contentType === 'string' ? body.contentType : null;
  if (!userId || !contentType) return Response.json({ error: 'invalid_request' }, { status: 400 });

  const path = `u/profiles/${userId}/avatar.png`;
  const uploadUrl = presignUploadUrl(env, path, contentType);
  return Response.json({ uploadUrl, path });
}
