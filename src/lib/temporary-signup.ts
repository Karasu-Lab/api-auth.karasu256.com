import { and, eq } from 'drizzle-orm';
import { APIError, createAuthEndpoint, createEmailVerificationToken } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { BetterAuthPlugin } from 'better-auth';
import { z } from 'zod';
import { createDb, type Db } from '../db/create-db';
import * as schema from '../db/schema';
import { FirebaseLinkUserWork } from './batch-works';
import { withAuth } from './request-auth';
import { waitUntil } from 'cloudflare:workers';

export const TEMPORARY_SIGNUP_COOKIE_NAME = 'temporary-signup';

const TEMPORARY_SIGNUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_SIGNUP_WINDOW_MS = 5 * 60 * 1000;
const CALLBACK_PATH = /^\/api\/auth\/callback\/([^/]+)$/;

const completeSignupBodySchema = z.object({
  name: z.string().trim().min(1),
  email: z.email(),
});

const temporarySignupPayloadSchema = z.object({
  userId: z.string().min(1),
  exp: z.number(),
});

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signTemporarySignupPayload(env: Env, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.BETTER_AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return encodeBase64Url(new Uint8Array(signature));
}

export async function createTemporarySignupCookieValue(env: Env, userId: string): Promise<string> {
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ userId, exp: Date.now() + TEMPORARY_SIGNUP_TTL_MS })));
  return `${payload}.${await signTemporarySignupPayload(env, payload)}`;
}

export async function readTemporarySignupUserId(env: Env, headers: Headers): Promise<string | null> {
  const cookieHeader = headers.get('cookie');
  if (!cookieHeader) return null;
  const raw = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${TEMPORARY_SIGNUP_COOKIE_NAME}=`))
    ?.slice(TEMPORARY_SIGNUP_COOKIE_NAME.length + 1);
  if (!raw) return null;
  const [payload, signature, extra] = decodeURIComponent(raw).split('.');
  if (!payload || !signature || extra) return null;
  if (!timingSafeEqual(signature, await signTemporarySignupPayload(env, payload))) return null;
  try {
    const parsed = temporarySignupPayloadSchema.safeParse(JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))));
    if (!parsed.success || parsed.data.exp < Date.now()) return null;
    return parsed.data.userId;
  } catch {
    return null;
  }
}

function cookieAttributes(env: Env): string[] {
  const attributes = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (env.BASE_DOMAIN) attributes.push(`Domain=${env.BASE_DOMAIN}`);
  if (env.BETTER_AUTH_URL.startsWith('https:')) attributes.push('Secure');
  return attributes;
}

export function temporarySignupCookieHeader(env: Env, value: string): string {
  return [`${TEMPORARY_SIGNUP_COOKIE_NAME}=${value}`, ...cookieAttributes(env), `Max-Age=${TEMPORARY_SIGNUP_TTL_MS / 1000}`].join('; ');
}

export function expiredTemporarySignupCookieHeader(env: Env): string {
  return [`${TEMPORARY_SIGNUP_COOKIE_NAME}=`, ...cookieAttributes(env), 'Max-Age=0'].join('; ');
}

function expiredSessionCookieHeader(env: Env, name: string): string {
  const securePrefix = env.BETTER_AUTH_URL.startsWith('https:') ? '__Secure-' : '';
  return [`${securePrefix}${env.APP_ENV}.${name}=`, ...cookieAttributes(env), 'Max-Age=0'].join('; ');
}

function isSessionSetCookie(env: Env, cookie: string): boolean {
  const name = cookie
    .split(';')[0]
    ?.split('=')[0]
    ?.trim()
    .replace(/^__Secure-/, '');
  return name === `${env.APP_ENV}.session_token` || name === `${env.APP_ENV}.session_data` || (name?.startsWith(`${env.APP_ENV}.session_data.`) ?? false);
}

function issuedSessionToken(env: Env, response: Response): string | null {
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';')[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim().replace(/^__Secure-/, '');
    if (name !== `${env.APP_ENV}.session_token`) continue;
    const token = decodeURIComponent(pair.slice(separator + 1)).split('.')[0];
    if (token) return token;
  }
  return null;
}

async function stageNewSignup(db: Db, user: schema.User, account: schema.Account): Promise<string> {
  return db.transaction(async (tx) => {
    let target: schema.TemporaryUser | undefined;
    if (user.email) {
      const [byEmail] = await tx.select().from(schema.temporaryUsers).where(eq(schema.temporaryUsers.email, user.email)).limit(1);
      target = byEmail;
    }
    if (!target) {
      await tx
        .insert(schema.temporaryUsers)
        .values({
          id: user.id,
          name: user.name,
          email: user.email,
          emailVerified: user.emailVerified,
          image: user.image,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        })
        .onConflictDoNothing();
      const [inserted] = await tx.select().from(schema.temporaryUsers).where(eq(schema.temporaryUsers.id, user.id)).limit(1);
      target = inserted;
    }
    if (!target) throw new Error('Failed to stage the temporary user.');

    const [existing] = await tx
      .select()
      .from(schema.temporaryAccounts)
      .where(and(eq(schema.temporaryAccounts.providerId, account.providerId), eq(schema.temporaryAccounts.accountId, account.accountId)))
      .limit(1);
    if (existing) {
      await tx.delete(schema.temporaryAccounts).where(eq(schema.temporaryAccounts.id, existing.id));
      if (existing.userId !== target.id) {
        const remaining = await tx
          .select({ id: schema.temporaryAccounts.id })
          .from(schema.temporaryAccounts)
          .where(eq(schema.temporaryAccounts.userId, existing.userId))
          .limit(1);
        if (remaining.length === 0) await tx.delete(schema.temporaryUsers).where(eq(schema.temporaryUsers.id, existing.userId));
      }
    }

    await tx.insert(schema.temporaryAccounts).values({
      id: account.id,
      accountId: account.accountId,
      providerId: account.providerId,
      userId: target.id,
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      idToken: account.idToken,
      accessTokenExpiresAt: account.accessTokenExpiresAt,
      refreshTokenExpiresAt: account.refreshTokenExpiresAt,
      scope: account.scope,
      password: account.password,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    });

    await tx.delete(schema.sessions).where(eq(schema.sessions.userId, user.id));
    await tx.delete(schema.users).where(eq(schema.users.id, user.id));
    return target.id;
  });
}

export class TemporarySignupStaging {
  readonly providerId: string | null;
  private linkUserId: string | null = null;
  private readonly capturedAt = new Date();
  private readonly preExistingAccountIds = new Set<string>();

  constructor(
    private readonly env: Env,
    private readonly request: Request,
    pathname: string
  ) {
    this.providerId = CALLBACK_PATH.exec(pathname)?.[1] ?? null;
  }

  get isCallback(): boolean {
    return this.providerId !== null && this.request.method === 'GET';
  }

  async captureLinkSource(): Promise<void> {
    try {
      const session = await withAuth(this.env, (auth) => auth.api.getSession({ headers: this.request.headers }));
      this.linkUserId = session?.user.id ?? null;
    } catch (error) {
      console.error('Failed to check the existing session before the OAuth callback:', error);
      this.linkUserId = null;
    }
    if (!this.providerId) return;
    const db = createDb(this.env.DATABASE_URL);
    try {
      const since = new Date(this.capturedAt.getTime() - RECENT_SIGNUP_WINDOW_MS);
      const recent = await db
        .select({ id: schema.accounts.id, createdAt: schema.accounts.createdAt })
        .from(schema.accounts)
        .where(eq(schema.accounts.providerId, this.providerId));
      for (const account of recent) {
        if (account.createdAt >= since) this.preExistingAccountIds.add(account.id);
      }
    } catch (error) {
      console.error('Failed to snapshot the existing accounts before the OAuth callback:', error);
    } finally {
      waitUntil(db.$client.end());
    }
  }

  async stage(response: Response): Promise<Response> {
    if (!this.isCallback) return response;
    try {
      return this.linkUserId ? await this.enforceLinkBlock(response, this.linkUserId) : await this.stageResponse(response);
    } catch (error) {
      console.error('Failed to post-process the OAuth callback for the temporary signup:', error);
      return response;
    }
  }

  private async enforceLinkBlock(response: Response, linkUserId: string): Promise<Response> {
    const location = response.headers.get('location');
    if (!location || new URL(location, this.env.BETTER_AUTH_URL).searchParams.has('error')) return response;

    const db = createDb(this.env.DATABASE_URL);
    try {
      const since = new Date(this.capturedAt.getTime() - RECENT_SIGNUP_WINDOW_MS);
      const created = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.userId, linkUserId), eq(schema.accounts.providerId, this.providerId!)));
      for (const account of created) {
        if (account.createdAt < since) continue;
        const [temporary] = await db
          .select({ id: schema.temporaryAccounts.id })
          .from(schema.temporaryAccounts)
          .where(and(eq(schema.temporaryAccounts.providerId, account.providerId), eq(schema.temporaryAccounts.accountId, account.accountId)))
          .limit(1);
        if (!temporary) continue;
        await db.delete(schema.accounts).where(eq(schema.accounts.id, account.id));
        console.error(
          `Blocked linking ${account.providerId} account ${account.accountId} to user ${linkUserId} because it belongs to an unfinished temporary signup.`
        );
        const destination = new URL('/oauth/error', this.env.AUTH_UI_URL);
        destination.searchParams.set('error', 'temporary_signup_conflict');
        return new Response(null, { status: 302, headers: { location: destination.toString() } });
      }
      return response;
    } finally {
      waitUntil(db.$client.end());
    }
  }

  private async stageResponse(response: Response): Promise<Response> {
    const location = response.headers.get('location');
    if (!location || new URL(location, this.env.BETTER_AUTH_URL).searchParams.has('error')) return response;
    const token = issuedSessionToken(this.env, response);
    if (!token) return response;

    const db = createDb(this.env.DATABASE_URL);
    try {
      const since = new Date(this.capturedAt.getTime() - RECENT_SIGNUP_WINDOW_MS);
      const [session] = await db.select().from(schema.sessions).where(eq(schema.sessions.token, token)).limit(1);
      if (!session || session.createdAt < since) return response;
      const [user] = await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).limit(1);
      if (!user || user.createdAt < since) return response;
      const [account] = await db
        .select()
        .from(schema.accounts)
        .where(and(eq(schema.accounts.userId, user.id), eq(schema.accounts.providerId, this.providerId!)))
        .limit(1);
      if (!account || account.createdAt < since || this.preExistingAccountIds.has(account.id)) return response;

      const temporaryUserId = await stageNewSignup(db, user, account);
      return await this.redirectToComplete(response, location, temporaryUserId);
    } finally {
      waitUntil(db.$client.end());
    }
  }

  private async redirectToComplete(response: Response, location: string, temporaryUserId: string): Promise<Response> {
    const headers = new Headers(response.headers);
    const destination = new URL('/sign-up/complete', this.env.AUTH_UI_URL);
    const next = new URL(location, this.env.BETTER_AUTH_URL).searchParams.get('next');
    if (next) destination.searchParams.set('next', next);
    headers.set('location', destination.toString());
    const keptCookies = response.headers.getSetCookie().filter((cookie) => !isSessionSetCookie(this.env, cookie));
    headers.delete('set-cookie');
    for (const cookie of keptCookies) headers.append('set-cookie', cookie);
    headers.append('set-cookie', expiredSessionCookieHeader(this.env, 'session_token'));
    headers.append('set-cookie', expiredSessionCookieHeader(this.env, 'session_data'));
    headers.append('set-cookie', temporarySignupCookieHeader(this.env, await createTemporarySignupCookieValue(this.env, temporaryUserId)));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}

async function loadTemporarySignup(db: Db, userId: string): Promise<{ user: schema.TemporaryUser; accounts: schema.TemporaryAccount[] } | null> {
  const [user] = await db.select().from(schema.temporaryUsers).where(eq(schema.temporaryUsers.id, userId)).limit(1);
  if (!user) return null;
  const accounts = await db.select().from(schema.temporaryAccounts).where(eq(schema.temporaryAccounts.userId, user.id));
  return { user, accounts };
}

export function temporarySignupPlugin(env: Env, db: Db) {
  return {
    id: 'temporary-signup',
    endpoints: {
      getTemporarySignup: createAuthEndpoint('/sign-up/temporary', { method: 'GET' }, async (ctx) => {
        const userId = await readTemporarySignupUserId(env, ctx.headers ?? new Headers());
        const loaded = userId ? await loadTemporarySignup(db, userId) : null;
        if (!loaded) {
          return new Response(JSON.stringify({ error: 'temporary_signup_not_found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        return ctx.json({
          user: { id: loaded.user.id, name: loaded.user.name, email: loaded.user.email, image: loaded.user.image },
          providers: loaded.accounts.map((account) => ({ providerId: account.providerId, accountId: account.accountId })),
        });
      }),
      completeTemporarySignup: createAuthEndpoint('/sign-up/complete', { method: 'POST', body: completeSignupBodySchema }, async (ctx) => {
        const userId = await readTemporarySignupUserId(env, ctx.headers ?? new Headers());
        if (!userId) throw new APIError('NOT_FOUND', { message: 'temporary_signup_not_found' });

        const target = await db.transaction(async (tx) => {
          const [temporaryUser] = await tx.select().from(schema.temporaryUsers).where(eq(schema.temporaryUsers.id, userId)).limit(1);
          if (!temporaryUser) return null;
          const temporaryAccounts = await tx.select().from(schema.temporaryAccounts).where(eq(schema.temporaryAccounts.userId, temporaryUser.id));

          let user: schema.User;
          const [existing] = await tx.select().from(schema.users).where(eq(schema.users.email, ctx.body.email)).limit(1);
          if (existing) {
            const [updated] = await tx
              .update(schema.users)
              .set({ name: ctx.body.name, updatedAt: new Date() })
              .where(eq(schema.users.id, existing.id))
              .returning();
            user = updated ?? existing;
          } else {
            const [inserted] = await tx
              .insert(schema.users)
              .values({
                id: temporaryUser.id,
                name: ctx.body.name,
                email: ctx.body.email,
                emailVerified: temporaryUser.emailVerified,
                image: temporaryUser.image,
                createdAt: temporaryUser.createdAt,
                updatedAt: new Date(),
              })
              .returning();
            if (!inserted) throw new Error('Failed to create the user from the temporary signup.');
            user = inserted;
          }

          for (const account of temporaryAccounts) {
            const [linked] = await tx
              .select({ id: schema.accounts.id })
              .from(schema.accounts)
              .where(and(eq(schema.accounts.providerId, account.providerId), eq(schema.accounts.accountId, account.accountId)))
              .limit(1);
            if (linked) continue;
            await tx.insert(schema.accounts).values({
              id: account.id,
              accountId: account.accountId,
              providerId: account.providerId,
              userId: user.id,
              accessToken: account.accessToken,
              refreshToken: account.refreshToken,
              idToken: account.idToken,
              accessTokenExpiresAt: account.accessTokenExpiresAt,
              refreshTokenExpiresAt: account.refreshTokenExpiresAt,
              scope: account.scope,
              password: account.password,
              createdAt: account.createdAt,
              updatedAt: account.updatedAt,
            });
          }

          await tx.delete(schema.temporaryAccounts).where(eq(schema.temporaryAccounts.userId, temporaryUser.id));
          await tx.delete(schema.temporaryUsers).where(eq(schema.temporaryUsers.id, temporaryUser.id));
          return user;
        });
        if (!target) throw new APIError('NOT_FOUND', { message: 'temporary_signup_not_found' });

        const session = await ctx.context.internalAdapter.createSession(target.id);
        await setSessionCookie(ctx, { session, user: { ...target, name: ctx.body.name, email: ctx.body.email } });
        ctx.setCookie(TEMPORARY_SIGNUP_COOKIE_NAME, '', {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          maxAge: 0,
          ...(env.BASE_DOMAIN ? { domain: env.BASE_DOMAIN } : {}),
          ...(env.BETTER_AUTH_URL.startsWith('https:') ? { secure: true } : {}),
        });
        if (!target.emailVerified && target.email) {
          const sendVerificationEmail = ctx.context.options.emailVerification?.sendVerificationEmail;
          if (sendVerificationEmail) {
            const verifiedUser = { ...target, name: ctx.body.name, email: ctx.body.email };
            const token = await createEmailVerificationToken(ctx.context.secret, verifiedUser.email, undefined, ctx.context.options.emailVerification?.expiresIn);
            const url = `${ctx.context.baseURL}/verify-email?token=${token}&callbackURL=${encodeURIComponent('/')}`;
            await ctx.context.runInBackgroundOrAwait(sendVerificationEmail({ user: verifiedUser, url, token }, ctx.request));
          }
        }
        await new FirebaseLinkUserWork(env, db).enqueue({ userId: target.id });
        return ctx.json({ user: { id: target.id, name: target.name, email: target.email } });
      }),
      cancelTemporarySignup: createAuthEndpoint('/sign-up/cancel', { method: 'POST' }, async (ctx) => {
        const userId = await readTemporarySignupUserId(env, ctx.headers ?? new Headers());
        const loaded = userId ? await loadTemporarySignup(db, userId) : null;
        if (!loaded) {
          return new Response(JSON.stringify({ error: 'temporary_signup_not_found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        await db.delete(schema.temporaryUsers).where(eq(schema.temporaryUsers.id, loaded.user.id));
        ctx.setCookie(TEMPORARY_SIGNUP_COOKIE_NAME, '', {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          maxAge: 0,
          ...(env.BASE_DOMAIN ? { domain: env.BASE_DOMAIN } : {}),
          ...(env.BETTER_AUTH_URL.startsWith('https:') ? { secure: true } : {}),
        });
        return ctx.json({ status: true });
      }),
    },
  } satisfies BetterAuthPlugin;
}
