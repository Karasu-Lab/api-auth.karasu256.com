import { describe, expect, it } from 'vitest';
import type { GenericOAuthUserInfo } from 'better-auth/plugins';
import type { Db } from '../src/db/create-db';
import { OAuthSignInFlow } from '../src/lib/oauth-sign-in-flow';

function fakeDb(rows: { email: string }[]): Db {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: async () => rows,
  };
  return { select: () => chain } as unknown as Db;
}

describe('OAuthSignInFlow', () => {
  it('keeps the provider email when one is present', async () => {
    const flow = new OAuthSignInFlow(fakeDb([{ email: 'linked@example.com' }]));
    await expect(flow.socialProfileMapper('github')({ id: 42, email: 'profile@example.com' })).resolves.toEqual({});
  });

  it('falls back to the linked account email keyed by the provider user id', async () => {
    const flow = new OAuthSignInFlow(fakeDb([{ email: 'linked@example.com' }]));
    await expect(flow.socialProfileMapper('github')({ id: 42, email: null })).resolves.toEqual({ email: 'linked@example.com' });
  });

  it('returns nothing when no account is linked for the provider user id', async () => {
    const flow = new OAuthSignInFlow(fakeDb([]));
    await expect(flow.socialProfileMapper('github')({ id: '42' })).resolves.toEqual({});
  });

  it('returns nothing when the profile has no user id', async () => {
    const flow = new OAuthSignInFlow(fakeDb([{ email: 'linked@example.com' }]));
    await expect(flow.socialProfileMapper('github')({ email: null })).resolves.toEqual({});
  });

  it('returns nothing without a database', async () => {
    const flow = new OAuthSignInFlow(null);
    await expect(flow.socialProfileMapper('github')({ id: 42, email: null })).resolves.toEqual({});
  });

  it('maps the github image together with the fallback email', async () => {
    const flow = new OAuthSignInFlow(fakeDb([{ email: 'linked@example.com' }]));
    const profile = { id: 42, email: null, avatar_url: 'https://avatars.example/42' } as unknown as GenericOAuthUserInfo;
    await expect(flow.githubProfileMapper('github-app')(profile)).resolves.toEqual({
      image: 'https://avatars.example/42',
      email: 'linked@example.com',
    });
  });
});
