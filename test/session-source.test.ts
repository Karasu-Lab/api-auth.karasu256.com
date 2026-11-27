import { beforeEach, describe, expect, it, vi } from 'vitest';

const holder = vi.hoisted(() => ({
  stored: new Map<string, string>(),
  rows: [] as { source: string }[],
}));

vi.mock('../src/lib/redis/session-source-repositories', () => ({
  SessionSourceGetRepository: class {
    constructor(
      _env: unknown,
      private readonly session: { id: string },
    ) {}

    async get(): Promise<string | null> {
      return holder.stored.get(this.session.id) ?? null;
    }
  },
  SessionSourceCreateRepository: class {
    constructor(
      _env: unknown,
      private readonly session: { id: string },
    ) {}

    async create(source: string): Promise<void> {
      holder.stored.set(this.session.id, source);
    }
  },
}));

import type { Db } from '../src/db/create-db';
import { SessionSourceStore } from '../src/lib/session-source';

const env = {} as Env;

const db = {
  insert: () => ({
    values: (value: { sessionId: string; source: string }) => ({
      onConflictDoNothing: async () => {
        holder.stored.set(value.sessionId, value.source);
      },
    }),
  }),
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => holder.rows,
      }),
    }),
  }),
} as unknown as Db;

function session(id: string): { id: string; userId: string; expiresAt: Date } {
  return { id, userId: 'user-1', expiresAt: new Date(Date.now() + 3600_000) };
}

describe('session source provider resolution', () => {
  const store = new SessionSourceStore(env, db);

  it.each([
    ['/callback/github', null, 'github'],
    ['/oauth2/callback/google', null, 'google'],
    ['/sso/callback/okta', null, 'okta'],
    ['/callback/github', { id: 'github-app' }, 'github-app'],
    ['/sign-in/social', { provider: 'google' }, 'google'],
    ['/sign-in/email', null, 'credential'],
    ['/sign-in/username', null, 'credential'],
    ['/sign-up/email', null, 'credential'],
    ['/sign-in/email-challenge', null, 'credential'],
    ['/email-challenge/verify-otp', null, 'credential'],
    ['/email-challenge/verify', null, 'credential'],
    ['/passkey/verify-authentication', null, 'credential'],
    ['/passkey/register', null, 'credential'],
    ['/one-time-token/verify', null, 'unknown'],
    [null, null, 'unknown'],
  ])('resolves %s to %s', (path, params, expected) => {
    expect(store.resolveProviderId({ path, params })).toBe(expected);
  });
});

describe('session source exposed on get-session', () => {
  beforeEach(() => {
    holder.stored.clear();
    holder.rows = [];
  });

  it('nests the provider id in the source after an OAuth login', async () => {
    const store = new SessionSourceStore(env, db);
    const created = session('session-oauth-1');

    await store.record(created, { path: '/callback/github', params: null });
    const source = await store.get(created);

    expect(source).toEqual({ raw: 'github-session-oauth-1', providerId: 'github' });
  });

  it('treats an OTP login as a credential source', async () => {
    const store = new SessionSourceStore(env, db);
    const created = session('session-otp-1');

    await store.record(created, { path: '/email-challenge/verify-otp', params: null });
    const source = await store.get(created);

    expect(source).toEqual({ raw: 'credential-session-otp-1', providerId: 'credential' });
  });

  it('treats a passkey login as a credential source', async () => {
    const store = new SessionSourceStore(env, db);
    const created = session('session-passkey-1');

    await store.record(created, { path: '/passkey/verify-authentication', params: null });
    const source = await store.get(created);

    expect(source).toEqual({ raw: 'credential-session-passkey-1', providerId: 'credential' });
  });

  it('falls back to an unknown source when nothing was recorded', async () => {
    const store = new SessionSourceStore(env, db);

    const source = await store.get(session('session-missing-1'));

    expect(source).toEqual({ raw: 'unknown-session-missing-1', providerId: 'unknown' });
  });

  it('falls back to an unknown source when the stored source belongs to another session', async () => {
    const store = new SessionSourceStore(env, db);
    holder.rows = [{ source: 'github-another-session' }];

    const source = await store.get(session('session-mismatch-1'));

    expect(source).toEqual({ raw: 'unknown-session-mismatch-1', providerId: 'unknown' });
  });
});
