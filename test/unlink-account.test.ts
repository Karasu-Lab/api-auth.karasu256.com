import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  findAccounts: vi.fn(),
  unlinkHandler: vi.fn(),
  deleteAccountLink: vi.fn(),
  deleteMinecraftStatus: vi.fn(),
  getSessionSource: vi.fn(),
  closeDb: vi.fn(),
  auth: {
    api: { getSession: vi.fn() },
    handler: vi.fn(),
    $context: Promise.resolve({ internalAdapter: { findAccounts: vi.fn() } }),
  },
}));

vi.mock('../src/db/create-db', () => ({
  createDb: () => ({ $client: { end: mocks.closeDb } }),
}));

vi.mock('../src/lib/auth', () => ({
  createAuth: async () => ({ handler: mocks.unlinkHandler }),
}));

vi.mock('../src/lib/avatar-api', () => ({
  deleteProviderAvatar: vi.fn(async () => undefined),
  storedAvatarProviderIds: (accountProvider: string) => [accountProvider],
}));

vi.mock('../src/lib/minecraft-link-status', () => ({
  normalizeMinecraftUuid: (value: string) => value,
}));

vi.mock('../src/lib/request-auth', () => ({
  withAuth: (_env: Env, callback: (auth: unknown) => Promise<unknown>) => callback(mocks.auth),
}));

vi.mock('../src/lib/redis/account-link-repositories', () => ({
  AccountLinkDeleteRepository: class {
    delete() {
      return mocks.deleteAccountLink();
    }
  },
}));

vi.mock('../src/lib/redis/minecraft-link-status-repositories', () => ({
  MinecraftLinkStatusDeleteRepository: class {
    delete() {
      return mocks.deleteMinecraftStatus();
    }
  },
}));

vi.mock('../src/lib/session-source', () => ({
  SessionSourceStore: class {
    get() {
      return mocks.getSessionSource();
    }
  },
}));

vi.mock('../src/lib/social-providers', () => ({
  createSocialProviders: () => ({ github: {} }),
}));

import type { DispatchContext } from '../src/lib/dispatch';
import { UnlinkAccountDispatch } from '../src/dispatch/unlink-account';

const env = { HYPERDRIVE: { connectionString: 'postgres://test' } } as Env;

function dispatch(): UnlinkAccountDispatch {
  const request = new Request('https://api-auth.example.test/api/auth/unlink-account', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: 'github' }),
  });
  return new UnlinkAccountDispatch({
    env,
    request,
    pathname: '/api/auth/unlink-account',
    body: { providerId: 'github' },
  } satisfies DispatchContext);
}

describe('account unlink dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      user: { id: 'user-1' },
      session: { id: 'session-1', expiresAt: new Date() },
    });
    mocks.findAccounts.mockResolvedValue([
      { id: 'account-row-github', providerId: 'github', accountId: 'github-1' },
      { id: 'account-row-password', providerId: 'password', accountId: 'user-1' },
    ]);
    mocks.auth.api.getSession.mockImplementation(mocks.getSession);
    mocks.auth.handler.mockImplementation(mocks.unlinkHandler);
    mocks.auth.$context = Promise.resolve({ internalAdapter: { findAccounts: mocks.findAccounts } });
    mocks.unlinkHandler.mockResolvedValue(Response.json({ status: true }));
    mocks.deleteAccountLink.mockResolvedValue(undefined);
    mocks.deleteMinecraftStatus.mockResolvedValue(undefined);
    mocks.getSessionSource.mockResolvedValue({ raw: 'credential-session-1', providerId: 'credential' });
  });

  it('returns the provider failure instead of reporting a false success and logs it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.unlinkHandler.mockResolvedValueOnce(
      Response.json({ code: 'ACCOUNT_UNLINK_FAILED', message: 'Provider rejected unlink.' }, { status: 400 }),
    );

    const response = await dispatch().handle();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'ACCOUNT_UNLINK_FAILED',
      reason: 'Provider rejected unlink.',
    });
    expect(mocks.deleteAccountLink).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0]?.[0]).toContain('Unlinking github failed with 400');
    expect(consoleError.mock.calls[0]?.[0]).toContain('ACCOUNT_UNLINK_FAILED');
    consoleError.mockRestore();
  });

  it('forwards the resolved account row id as accountId to the auth handler', async () => {
    const response = await dispatch().handle();

    expect(response.status).toBe(200);
    const forwarded = mocks.unlinkHandler.mock.calls[0]?.[0] as Request;
    expect(await forwarded.json()).toEqual({ providerId: 'github', accountId: 'account-row-github' });
  });

  it('blocks unlinking the provider the current session was created with when it is the only remaining login method', async () => {
    mocks.findAccounts.mockResolvedValue([{ id: 'account-row-github', providerId: 'github', accountId: 'github-1' }]);
    mocks.getSessionSource.mockResolvedValue({ raw: 'github-session-1', providerId: 'github' });

    const response = await dispatch().handle();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'account_unlink_blocked',
      reason: 'The provider used to sign in to the current session cannot be unlinked while it is the only remaining login method.',
    });
    expect(mocks.getSessionSource).toHaveBeenCalledOnce();
    expect(mocks.unlinkHandler).not.toHaveBeenCalled();
    expect(mocks.deleteAccountLink).not.toHaveBeenCalled();
  });

  it('allows unlinking the provider the current session was created with when another login method remains', async () => {
    mocks.getSessionSource.mockResolvedValue({ raw: 'github-session-1', providerId: 'github' });

    const response = await dispatch().handle();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: true });
    expect(mocks.unlinkHandler).toHaveBeenCalledOnce();
  });

  it('derives the source from the session id and delegates when the session was created with a different provider', async () => {
    mocks.findAccounts.mockResolvedValue([{ id: 'account-row-github', providerId: 'github', accountId: 'github-1' }]);

    const response = await dispatch().handle();

    expect(response.status).toBe(200);
    expect(mocks.getSessionSource).toHaveBeenCalledOnce();
    expect(mocks.unlinkHandler).toHaveBeenCalledOnce();
    const forwarded = mocks.unlinkHandler.mock.calls[0]?.[0] as Request;
    expect(await forwarded.json()).toEqual({ providerId: 'github' });
    expect(mocks.deleteAccountLink).not.toHaveBeenCalled();
  });

  it('clears cached state only after the provider confirms unlinking', async () => {
    const response = await dispatch().handle();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: true });
    expect(mocks.unlinkHandler.mock.invocationCallOrder[0]).toBeLessThan(mocks.deleteAccountLink.mock.invocationCallOrder[0]);
    expect(mocks.deleteAccountLink).toHaveBeenCalledOnce();
    expect(mocks.closeDb).toHaveBeenCalledOnce();
  });
});
