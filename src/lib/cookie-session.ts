import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CookieSessionCreateRepository, CookieSessionGetRepository } from './redis/cookie-session-repositories';
import { isSessionExpired } from './session-expiry';

const cachedSessionSchema = z.object({
  sessionId: z.string(),
  body: z.string(),
  jwt: z.string().nullable(),
  exposeHeaders: z.string().nullable(),
});

export class CookieSessionStore {
  private readonly cookieHash: string | null;

  constructor(
    private readonly env: Env,
    request: Request
  ) {
    const name = `${env.BETTER_AUTH_URL.startsWith('https:') ? '__Secure-' : ''}better-auth.session_token`;
    const value = request.headers
      .get('cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`))
      ?.slice(name.length + 1);
    this.cookieHash = value ? createHash('sha256').update(value).digest('hex') : null;
  }

  async get(): Promise<Response | null> {
    if (!this.cookieHash) return null;
    const cached = await new CookieSessionGetRepository(this.env).get(this.cookieHash);
    if (!cached) return null;
    const { sessionId, body, jwt, exposeHeaders } = cachedSessionSchema.parse(JSON.parse(cached));
    if (await isSessionExpired(this.env, sessionId)) return null;
    const headers = new Headers({ 'content-type': 'application/json' });
    if (jwt) headers.set('set-auth-jwt', jwt);
    if (exposeHeaders) headers.set('access-control-expose-headers', exposeHeaders);
    return new Response(body, { headers });
  }

  async save(response: Response): Promise<void> {
    if (!this.cookieHash || !response.ok || response.headers.has('set-cookie')) return;
    const body = await response.clone().text();
    const sessionId = z.object({ session: z.object({ id: z.string() }) }).safeParse(JSON.parse(body));
    if (!sessionId.success) return;
    const value = JSON.stringify({
      sessionId: sessionId.data.session.id,
      body,
      jwt: response.headers.get('set-auth-jwt'),
      exposeHeaders: response.headers.get('access-control-expose-headers'),
    });
    await new CookieSessionCreateRepository(this.env).create(this.cookieHash, value, 60);
  }
}
