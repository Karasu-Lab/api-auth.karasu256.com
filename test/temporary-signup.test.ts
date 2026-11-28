import { createHmac } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/create-db';
import { TemporarySignupStaging, temporarySignupPlugin } from '../src/lib/temporary-signup';

const SECRET = 'temporary-signup-test-secret';
const BASE_URL = 'https://auth.test';
const AUTH_UI_URL = 'https://auth-ui.test';

type Row = Record<string, unknown>;

const holder = vi.hoisted(() => ({
  fakeDb: null as unknown,
  auth: null as unknown,
}));

vi.mock('cloudflare:workers', () => ({ waitUntil: () => undefined }));

vi.mock('@upstash/redis/cloudflare', () => ({
  Redis: class {
    async ping() {
      return 'PONG';
    }
    async get() {
      return null;
    }
    async set() {
      return 'OK';
    }
    async del() {
      return 0;
    }
  },
}));

vi.mock('../src/db/create-db', () => ({
  createDb: () => holder.fakeDb,
}));

vi.mock('../src/lib/request-auth', () => ({
  withAuth: async (_env: unknown, fn: (auth: never) => Promise<unknown>) => fn(holder.auth as never),
}));

function extractPredicates(condition: unknown, fieldsByColumn: Map<string, string>, out: { field: string; value: unknown }[] = []): { field: string; value: unknown }[] {
  if (!condition || typeof condition !== 'object') return out;
  const chunks = (condition as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return out;
  let pending: string | null = null;
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (Array.isArray((chunk as { queryChunks?: unknown[] }).queryChunks)) {
      extractPredicates(chunk, fieldsByColumn, out);
      pending = null;
    } else if ('table' in chunk && typeof (chunk as { name?: unknown }).name === 'string') {
      pending = fieldsByColumn.get((chunk as { name: string }).name) ?? null;
    } else if ('encoder' in chunk && pending) {
      out.push({ field: pending, value: (chunk as { value: unknown }).value });
      pending = null;
    }
  }
  return out;
}

class FakeDb {
  readonly $client = { end: async () => undefined };
  private readonly tables = new Map<string, Row[]>();

  rows(name: string): Row[] {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name) as Row[];
  }

  seed(name: string, row: Row): void {
    this.rows(name).push({ ...row });
  }

  select(fields?: Record<string, unknown>) {
    const state: { table?: unknown; condition?: unknown; limit?: number } = {};
    const run = (): Row[] => {
      const table = state.table as Parameters<typeof getTableColumns>[0];
      const columns = getTableColumns(table);
      const fieldsByColumn = new Map(Object.entries(columns).map(([field, column]) => [column.name, field]));
      const predicates = state.condition ? extractPredicates(state.condition, fieldsByColumn) : [];
      let result = this.rows(getTableName(table)).filter((row) => predicates.every((predicate) => row[predicate.field] === predicate.value));
      if (state.limit !== undefined) result = result.slice(0, state.limit);
      if (!fields) return result.map((row) => ({ ...row }));
      const projected = Object.entries(fields).map(([key, column]) => {
        const field = Object.entries(columns).find(([, candidate]) => candidate === column)?.[0] ?? key;
        return [key, field] as const;
      });
      return result.map((row) => Object.fromEntries(projected.map(([key, field]) => [key, row[field]])));
    };
    const builder: Record<string, unknown> = {
      from: (table: unknown) => {
        state.table = table;
        return builder;
      },
      where: (condition: unknown) => {
        state.condition = condition;
        return builder;
      },
      limit: (limit: number) => {
        state.limit = limit;
        return builder;
      },
      then: (resolve: (value: Row[]) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject),
    };
    return builder;
  }

  insert(table: unknown) {
    const name = getTableName(table as Parameters<typeof getTableName>[0]);
    const columns = getTableColumns(table as Parameters<typeof getTableColumns>[0]);
    const primaryKey = Object.entries(columns).find(([, column]) => column.primaryKey)?.[0];
    const state: { values?: Row; mode: 'plain' | 'nothing' | 'update'; updateValues?: Row; done?: boolean; result?: Row[] } = { mode: 'plain' };
    const run = (): Row[] => {
      if (state.done) return state.result as Row[];
      state.done = true;
      const rows = this.rows(name);
      const values = state.values as Row;
      const existing = primaryKey ? rows.find((row) => row[primaryKey] === values[primaryKey]) : undefined;
      if (existing && state.mode === 'nothing') {
        state.result = [];
      } else if (existing && state.mode === 'update') {
        Object.assign(existing, state.updateValues);
        state.result = [{ ...existing }];
      } else if (existing) {
        state.result = [{ ...existing }];
      } else {
        rows.push({ ...values });
        state.result = [{ ...values }];
      }
      return state.result;
    };
    const builder: Record<string, unknown> = {
      values: (values: Row) => {
        state.values = values;
        return builder;
      },
      onConflictDoNothing: () => {
        state.mode = 'nothing';
        return builder;
      },
      onConflictDoUpdate: (options: { set: Row }) => {
        state.mode = 'update';
        state.updateValues = options.set;
        return builder;
      },
      returning: () => builder,
      then: (resolve: (value: Row[]) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject),
    };
    return builder;
  }

  update(table: unknown) {
    const name = getTableName(table as Parameters<typeof getTableName>[0]);
    const columns = getTableColumns(table as Parameters<typeof getTableColumns>[0]);
    const fieldsByColumn = new Map(Object.entries(columns).map(([field, column]) => [column.name, field]));
    const state: { setValues?: Row; condition?: unknown } = {};
    const run = (): Row[] => {
      const predicates = state.condition ? extractPredicates(state.condition, fieldsByColumn) : [];
      const matched = this.rows(name).filter((row) => predicates.every((predicate) => row[predicate.field] === predicate.value));
      for (const row of matched) Object.assign(row, state.setValues);
      return matched.map((row) => ({ ...row }));
    };
    const builder: Record<string, unknown> = {
      set: (values: Row) => {
        state.setValues = values;
        return builder;
      },
      where: (condition: unknown) => {
        state.condition = condition;
        return builder;
      },
      returning: () => builder,
      then: (resolve: (value: Row[]) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject),
    };
    return builder;
  }

  delete(table: unknown) {
    const name = getTableName(table as Parameters<typeof getTableName>[0]);
    const columns = getTableColumns(table as Parameters<typeof getTableColumns>[0]);
    const fieldsByColumn = new Map(Object.entries(columns).map(([field, column]) => [column.name, field]));
    const state: { condition?: unknown } = {};
    const run = (): void => {
      const predicates = state.condition ? extractPredicates(state.condition, fieldsByColumn) : [];
      const rows = this.rows(name);
      const removed = rows.filter((row) => predicates.every((predicate) => row[predicate.field] === predicate.value));
      this.tables.set(
        name,
        rows.filter((row) => !removed.includes(row))
      );
      const removedIds = new Set(removed.map((row) => row.id));
      if (name === 'users') {
        for (const dependent of ['account', 'session']) {
          this.tables.set(
            dependent,
            this.rows(dependent).filter((row) => !removedIds.has(row.userId as string))
          );
        }
      }
      if (name === 'temporary_users') {
        this.tables.set(
          'temporary_accounts',
          this.rows('temporary_accounts').filter((row) => !removedIds.has(row.userId as string))
        );
      }
    };
    const builder: Record<string, unknown> = {
      where: (condition: unknown) => {
        state.condition = condition;
        return builder;
      },
      then: (resolve: (value: void) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject),
    };
    return builder;
  }

  async transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

const env = {
  APP_ENV: 'local',
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: BASE_URL,
  AUTH_UI_URL,
  DATABASE_URL: 'postgres://unused',
} as unknown as Env;

type SentEmail = { user: { email?: string | null }; url: string; token: string };

function buildAuth(fakeDb: FakeDb, sentEmails: SentEmail[]) {
  const memory = {
    user: [] as Row[],
    session: [] as Row[],
    account: [] as Row[],
    verification: [] as Row[],
  };
  const auth = betterAuth({
    secret: SECRET,
    baseURL: BASE_URL,
    database: memoryAdapter(memory),
    emailAndPassword: { enabled: true },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url, token }) => {
        sentEmails.push({ user: user as { email?: string | null }, url, token });
      },
    },
    plugins: [temporarySignupPlugin(env, fakeDb as unknown as Db)],
  });
  return { auth, memory };
}

function temporaryCookieValue(response: Response): string {
  const cookie = response.headers.getSetCookie().find((entry) => entry.startsWith('temporary-signup='));
  if (!cookie) throw new Error('The staged response did not set the temporary-signup cookie.');
  return (cookie.split(';')[0] as string).slice('temporary-signup='.length);
}

async function simulateProviderSignup(fakeDb: FakeDb, auth: ReturnType<typeof buildAuth>['auth']) {
  const request = new Request(`${BASE_URL}/api/auth/callback/github`);
  const staging = new TemporarySignupStaging(env, request, '/api/auth/callback/github');
  await staging.captureLinkSource();

  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ email: 'provider@example.com', name: 'Provider User', emailVerified: false });
  const account = await ctx.internalAdapter.createAccount({
    userId: user.id,
    providerId: 'github',
    accountId: 'github-user-1',
    accessToken: 'access-token',
  });
  const session = await ctx.internalAdapter.createSession(user.id, false);
  fakeDb.seed('users', {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    image: user.image ?? null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  });
  fakeDb.seed('account', {
    id: account.id,
    accountId: account.accountId,
    providerId: account.providerId,
    userId: user.id,
    accessToken: 'access-token',
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    scope: null,
    password: null,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  });
  fakeDb.seed('session', {
    id: session.id,
    expiresAt: session.expiresAt,
    token: session.token,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ipAddress: null,
    userAgent: null,
    userId: user.id,
  });

  const response = await staging.stage(
    new Response(null, {
      status: 302,
      headers: {
        location: `${AUTH_UI_URL}/auth/callback?next=${encodeURIComponent('https://accounts.test/home')}`,
        'set-cookie': `local.session_token=${session.token}.signature; Path=/; HttpOnly`,
      },
    })
  );
  return { user, account, session, response };
}

async function completeSignup(auth: ReturnType<typeof buildAuth>['auth'], cookieValue: string): Promise<Response> {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-up/complete`, {
      method: 'POST',
      headers: { cookie: `temporary-signup=${cookieValue}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Completed User', email: 'completed@example.com' }),
    })
  );
}

describe('temporary user signup', () => {
  let fakeDb: FakeDb;
  let sentEmails: SentEmail[];
  let auth: ReturnType<typeof buildAuth>['auth'];
  let memory: ReturnType<typeof buildAuth>['memory'];

  beforeEach(() => {
    fakeDb = new FakeDb();
    sentEmails = [];
    const built = buildAuth(fakeDb, sentEmails);
    auth = built.auth;
    memory = built.memory;
    holder.fakeDb = fakeDb;
    holder.auth = auth;
  });

  it('stages a provider sign-up, restores it, and completes it into a real user with a session', async () => {
    const { response } = await simulateProviderSignup(fakeDb, auth);

    const location = new URL(response.headers.get('location') as string);
    expect(location.origin + location.pathname).toBe(`${AUTH_UI_URL}/sign-up/complete`);
    expect(location.searchParams.get('next')).toBe('https://accounts.test/home');
    expect(response.headers.getSetCookie().some((entry) => entry.includes('local.session_token=') && entry.includes('Max-Age=0'))).toBe(true);
    expect(fakeDb.rows('users')).toHaveLength(0);
    expect(fakeDb.rows('session')).toHaveLength(0);
    expect(fakeDb.rows('temporary_users')).toHaveLength(1);
    expect(fakeDb.rows('temporary_accounts')).toHaveLength(1);
    expect(fakeDb.rows('temporary_accounts')[0]).toMatchObject({ providerId: 'github', accountId: 'github-user-1' });
    expect(sentEmails).toHaveLength(0);
    expect(memory.verification).toHaveLength(0);

    const cookieValue = temporaryCookieValue(response);
    const restored = await auth.handler(new Request(`${BASE_URL}/api/auth/sign-up/temporary`, { headers: { cookie: `temporary-signup=${cookieValue}` } }));
    expect(restored.status).toBe(200);
    const restoredBody = (await restored.json()) as { user: { email: string }; providers: { providerId: string; accountId: string }[] };
    expect(restoredBody.user.email).toBe('provider@example.com');
    expect(restoredBody.providers).toEqual([{ providerId: 'github', accountId: 'github-user-1' }]);

    const completed = await completeSignup(auth, cookieValue);
    expect(completed.status).toBe(200);
    const completedBody = (await completed.json()) as { user: { id: string; name: string; email: string } };
    expect(completedBody.user).toMatchObject({ name: 'Completed User', email: 'completed@example.com' });
    expect(fakeDb.rows('users')).toHaveLength(1);
    expect(fakeDb.rows('users')[0]).toMatchObject({ id: completedBody.user.id, name: 'Completed User', email: 'completed@example.com' });
    expect(fakeDb.rows('account')).toHaveLength(1);
    expect(fakeDb.rows('account')[0]).toMatchObject({ providerId: 'github', accountId: 'github-user-1', userId: completedBody.user.id });
    expect(fakeDb.rows('temporary_users')).toHaveLength(0);
    expect(fakeDb.rows('temporary_accounts')).toHaveLength(0);
    expect(completed.headers.getSetCookie().some((entry) => entry.includes('session_token='))).toBe(true);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]?.user.email).toBe('completed@example.com');
    expect(sentEmails[0]?.url).toContain('/verify-email?token=');
  });

  it('does not loop back to the completion page when the same provider signs in after completion', async () => {
    const { response } = await simulateProviderSignup(fakeDb, auth);
    const cookieValue = temporaryCookieValue(response);
    const completed = await completeSignup(auth, cookieValue);
    expect(completed.status).toBe(200);
    const userId = fakeDb.rows('users')[0]?.id as string;

    const staging = new TemporarySignupStaging(env, new Request(`${BASE_URL}/api/auth/callback/github`), '/api/auth/callback/github');
    await staging.captureLinkSource();
    fakeDb.seed('session', {
      id: 'session-after-completion',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      token: 'token-after-completion',
      createdAt: new Date(),
      updatedAt: new Date(),
      ipAddress: null,
      userAgent: null,
      userId,
    });
    const second = await staging.stage(
      new Response(null, {
        status: 302,
        headers: {
          location: `${AUTH_UI_URL}/auth/callback?next=${encodeURIComponent('https://accounts.test/home')}`,
          'set-cookie': 'local.session_token=token-after-completion.signature; Path=/; HttpOnly',
        },
      })
    );
    expect(second.headers.get('location')).toContain('/auth/callback');
    expect(second.headers.get('location')).not.toContain('/sign-up/complete');
    expect(second.headers.getSetCookie().some((entry) => entry.startsWith('temporary-signup='))).toBe(false);
    expect(fakeDb.rows('temporary_users')).toHaveLength(0);

    const restored = await auth.handler(new Request(`${BASE_URL}/api/auth/sign-up/temporary`, { headers: { cookie: `temporary-signup=${cookieValue}` } }));
    expect(restored.status).toBe(404);
    expect(await restored.json()).toEqual({ error: 'temporary_signup_not_found' });
  });

  it('blocks linking a provider account that belongs to an unfinished temporary signup', async () => {
    const now = new Date();
    fakeDb.seed('temporary_users', {
      id: 'temporary-user-1',
      name: 'Temporary User',
      email: 'temporary@example.com',
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    fakeDb.seed('temporary_accounts', {
      id: 'temporary-account-1',
      accountId: 'github-user-1',
      providerId: 'github',
      userId: 'temporary-user-1',
      accessToken: 'access-token',
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: null,
      password: null,
      createdAt: now,
      updatedAt: now,
    });

    const ctx = await auth.$context;
    const realUser = await ctx.internalAdapter.createUser({ email: 'real@example.com', name: 'Real User', emailVerified: true });
    const realSession = await ctx.internalAdapter.createSession(realUser.id, false);
    fakeDb.seed('users', {
      id: realUser.id,
      name: realUser.name,
      email: realUser.email,
      emailVerified: true,
      image: null,
      createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      updatedAt: now,
    });
    const signature = createHmac('sha256', SECRET).update(realSession.token).digest('base64');
    const request = new Request(`${BASE_URL}/api/auth/callback/github`, {
      headers: { cookie: `__Secure-better-auth.session_token=${encodeURIComponent(`${realSession.token}.${signature}`)}` },
    });
    const staging = new TemporarySignupStaging(env, request, '/api/auth/callback/github');
    await staging.captureLinkSource();
    fakeDb.seed('account', {
      id: 'linked-account-row',
      accountId: 'github-user-1',
      providerId: 'github',
      userId: realUser.id,
      accessToken: 'access-token',
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: null,
      password: null,
      createdAt: now,
      updatedAt: now,
    });
    const response = await staging.stage(
      new Response(null, { status: 302, headers: { location: `${AUTH_UI_URL}/auth/callback?next=${encodeURIComponent('https://accounts.test/settings/linking')}` } })
    );

    const location = new URL(response.headers.get('location') as string);
    expect(location.origin + location.pathname).toBe(`${AUTH_UI_URL}/oauth/error`);
    expect(location.searchParams.get('error')).toBe('temporary_signup_conflict');
    expect(fakeDb.rows('account').filter((row) => row.userId === realUser.id)).toHaveLength(0);
    expect(fakeDb.rows('temporary_accounts')).toHaveLength(1);
    expect(fakeDb.rows('temporary_users')).toHaveLength(1);
  });

  it('cancels the temporary signup and removes the staged user and provider links', async () => {
    const { response } = await simulateProviderSignup(fakeDb, auth);
    const cookieValue = temporaryCookieValue(response);
    expect(fakeDb.rows('temporary_users')).toHaveLength(1);
    expect(fakeDb.rows('temporary_accounts')).toHaveLength(1);

    const cancelled = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-up/cancel`, {
        method: 'POST',
        headers: { cookie: `temporary-signup=${cookieValue}` },
      })
    );
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ status: true });
    expect(fakeDb.rows('temporary_users')).toHaveLength(0);
    expect(fakeDb.rows('temporary_accounts')).toHaveLength(0);

    const restored = await auth.handler(new Request(`${BASE_URL}/api/auth/sign-up/temporary`, { headers: { cookie: `temporary-signup=${cookieValue}` } }));
    expect(restored.status).toBe(404);

    const cancelledAgain = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-up/cancel`, {
        method: 'POST',
        headers: { cookie: `temporary-signup=${cookieValue}` },
      })
    );
    expect(cancelledAgain.status).toBe(404);
    expect(await cancelledAgain.json()).toEqual({ error: 'temporary_signup_not_found' });
  });
});
