import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createFirebaseUser: vi.fn(),
  findFirebaseUidByEmail: vi.fn(),
  updateFirebaseUser: vi.fn(),
}));

vi.mock('../src/lib/firebase', () => ({
  createFirebaseUser: mocks.createFirebaseUser,
  findFirebaseUidByEmail: mocks.findFirebaseUidByEmail,
  updateFirebaseUser: mocks.updateFirebaseUser,
}));

import type { Db } from '../src/db/create-db';
import * as schema from '../src/db/schema';
import { ensureFirebaseLink } from '../src/lib/firebase-link';

const env = {} as Env;

interface Fixture {
  user?: { id: string; email: string | null; emailVerified: boolean; name: string | null; image: string | null };
  firebaseUid?: string | null;
  googleAccountId?: string;
  updates: { firebaseUid?: string }[];
}

function fakeDb(fixture: Fixture): Db {
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === schema.users) return fixture.user ? [fixture.user] : [];
            if (table === schema.firebaseUsers) return [{ firebaseUid: fixture.firebaseUid ?? null }];
            if (table === schema.accounts) return fixture.googleAccountId ? [{ accountId: fixture.googleAccountId }] : [];
            return [];
          },
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: async () => undefined,
      }),
    }),
    update: () => ({
      set: (values: { firebaseUid?: string }) => ({
        where: async () => {
          fixture.updates.push(values);
        },
      }),
    }),
  };
  return db as unknown as Db;
}

describe('ensureFirebaseLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createFirebaseUser.mockResolvedValue('firebase-uid-new');
    mocks.findFirebaseUidByEmail.mockResolvedValue(null);
    mocks.updateFirebaseUser.mockResolvedValue(undefined);
  });

  it('creates the Firebase account with Admin and links it as a Google account when there is no email', async () => {
    const fixture: Fixture = {
      user: { id: 'user-1', email: null, emailVerified: false, name: 'Hikara', image: null },
      googleAccountId: 'google-sub-1',
      updates: [],
    };

    await ensureFirebaseLink(env, fakeDb(fixture), 'user-1');

    expect(mocks.findFirebaseUidByEmail).not.toHaveBeenCalled();
    expect(mocks.createFirebaseUser).toHaveBeenCalledOnce();
    expect(mocks.createFirebaseUser.mock.calls[0]?.[1]).toEqual({
      displayName: 'Hikara',
      providerUserInfo: [{ providerId: 'google.com', rawId: 'google-sub-1' }],
    });
    expect(fixture.updates).toEqual([{ firebaseUid: 'firebase-uid-new', updatedAt: expect.any(Date) }]);
  });

  it('creates the Firebase account with Admin when there is no email and no Google account', async () => {
    const fixture: Fixture = {
      user: { id: 'user-1', email: null, emailVerified: false, name: 'Hikara', image: null },
      updates: [],
    };

    await ensureFirebaseLink(env, fakeDb(fixture), 'user-1');

    expect(mocks.createFirebaseUser).toHaveBeenCalledOnce();
    expect(mocks.createFirebaseUser.mock.calls[0]?.[1]).toEqual({ displayName: 'Hikara' });
    expect(fixture.updates).toEqual([{ firebaseUid: 'firebase-uid-new', updatedAt: expect.any(Date) }]);
  });

  it('keeps finding or creating by email when the user has an email', async () => {
    const fixture: Fixture = {
      user: { id: 'user-1', email: 'user@example.com', emailVerified: true, name: 'Hikara', image: null },
      updates: [],
    };

    await ensureFirebaseLink(env, fakeDb(fixture), 'user-1');

    expect(mocks.findFirebaseUidByEmail).toHaveBeenCalledWith(env, 'user@example.com');
    expect(mocks.createFirebaseUser).toHaveBeenCalledOnce();
    expect(mocks.createFirebaseUser.mock.calls[0]?.[1]).toEqual({
      email: 'user@example.com',
      emailVerified: true,
      displayName: 'Hikara',
    });
    expect(fixture.updates).toEqual([{ firebaseUid: 'firebase-uid-new', updatedAt: expect.any(Date) }]);
  });

  it('creates the Firebase account as a Google account when the user has an email and a Google account', async () => {
    const fixture: Fixture = {
      user: { id: 'user-1', email: 'user@example.com', emailVerified: true, name: 'Hikara', image: null },
      googleAccountId: 'google-sub-1',
      updates: [],
    };

    await ensureFirebaseLink(env, fakeDb(fixture), 'user-1');

    expect(mocks.createFirebaseUser).toHaveBeenCalledOnce();
    expect(mocks.createFirebaseUser.mock.calls[0]?.[1]).toEqual({
      email: 'user@example.com',
      emailVerified: true,
      displayName: 'Hikara',
      providerUserInfo: [{ providerId: 'google.com', rawId: 'google-sub-1' }],
    });
    expect(fixture.updates).toEqual([{ firebaseUid: 'firebase-uid-new', updatedAt: expect.any(Date) }]);
  });

  it('links Google to the Firebase account found by email instead of creating a new one', async () => {
    const fixture: Fixture = {
      user: { id: 'user-1', email: 'user@example.com', emailVerified: true, name: 'Hikara', image: null },
      googleAccountId: 'google-sub-1',
      updates: [],
    };
    mocks.findFirebaseUidByEmail.mockResolvedValue('firebase-uid-existing');

    await ensureFirebaseLink(env, fakeDb(fixture), 'user-1');

    expect(mocks.createFirebaseUser).not.toHaveBeenCalled();
    expect(mocks.updateFirebaseUser).toHaveBeenCalledOnce();
    expect(mocks.updateFirebaseUser.mock.calls[0]?.[1]).toBe('firebase-uid-existing');
    expect(mocks.updateFirebaseUser.mock.calls[0]?.[2]).toEqual({
      displayName: 'Hikara',
      photoURL: undefined,
      providerUserInfo: [{ providerId: 'google.com', rawId: 'google-sub-1' }],
    });
    expect(fixture.updates).toEqual([{ firebaseUid: 'firebase-uid-existing', updatedAt: expect.any(Date) }]);
  });

  it('adds the Google provider when a Firebase account is already linked', async () => {
    const fixture: Fixture = {
      user: { id: 'user-1', email: 'user@example.com', emailVerified: true, name: 'Hikara', image: null },
      firebaseUid: 'firebase-uid-existing',
      googleAccountId: 'google-sub-1',
      updates: [],
    };

    await ensureFirebaseLink(env, fakeDb(fixture), 'user-1');

    expect(mocks.createFirebaseUser).not.toHaveBeenCalled();
    expect(mocks.updateFirebaseUser).toHaveBeenCalledOnce();
    expect(mocks.updateFirebaseUser.mock.calls[0]?.[1]).toBe('firebase-uid-existing');
    expect(mocks.updateFirebaseUser.mock.calls[0]?.[2]).toEqual({
      displayName: 'Hikara',
      photoURL: undefined,
      providerUserInfo: [{ providerId: 'google.com', rawId: 'google-sub-1' }],
    });
    expect(fixture.updates).toEqual([]);
  });

  it('only syncs the profile when a Firebase account is already linked', async () => {
    const fixture: Fixture = {
      user: { id: 'user-1', email: null, emailVerified: false, name: 'Hikara', image: null },
      firebaseUid: 'firebase-uid-existing',
      updates: [],
    };

    await ensureFirebaseLink(env, fakeDb(fixture), 'user-1');

    expect(mocks.createFirebaseUser).not.toHaveBeenCalled();
    expect(mocks.updateFirebaseUser).toHaveBeenCalledOnce();
    expect(fixture.updates).toEqual([]);
  });
});
