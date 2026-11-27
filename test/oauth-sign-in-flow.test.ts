import { describe, expect, it } from 'vitest';
import type { GenericOAuthUserInfo } from 'better-auth/plugins';
import { OAuthSignInFlow } from '../src/lib/oauth-sign-in-flow';

describe('OAuthSignInFlow', () => {
  it('keeps the provider email when one is present', async () => {
    const flow = new OAuthSignInFlow();
    await expect(flow.socialProfileMapper()({ id: 42, email: 'profile@example.com' })).resolves.toEqual({});
  });

  it('uses the provider user id as the email when the provider returns no email', async () => {
    const flow = new OAuthSignInFlow();
    await expect(flow.socialProfileMapper()({ id: 42, email: null })).resolves.toEqual({ email: '42' });
  });

  it('uses the provider user id as the email when the profile has no email field', async () => {
    const flow = new OAuthSignInFlow();
    await expect(flow.socialProfileMapper()({ id: '42' })).resolves.toEqual({ email: '42' });
  });

  it('returns nothing when the profile has no user id', async () => {
    const flow = new OAuthSignInFlow();
    await expect(flow.socialProfileMapper()({ email: null })).resolves.toEqual({});
  });

  it('maps the github image together with the provider user id as the email', async () => {
    const flow = new OAuthSignInFlow();
    const profile = { id: 42, email: null, avatar_url: 'https://avatars.example/42' } as unknown as GenericOAuthUserInfo;
    await expect(flow.githubProfileMapper()(profile)).resolves.toEqual({
      image: 'https://avatars.example/42',
      email: '42',
    });
  });
});
