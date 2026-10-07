import type { GenericOAuthConfig } from 'better-auth/plugins';

/** Returns the mock OAuth server URL for end-to-end tests, never in production. */
export function getMockOAuthUrl(env: Env): string | null {
  if (env.APP_ENV !== 'local') return null;
  return env.E2E_MOCK_OAUTH_URL || null;
}

export function getMockOAuthProviders(mockUrl: string): GenericOAuthConfig[] {
  return ['google', 'github'].map((providerId) => ({
    providerId,
    clientId: `mock-${providerId}`,
    clientSecret: `mock-${providerId}-secret`,
    authorizationUrl: `${mockUrl}/${providerId}/authorize`,
    tokenUrl: `${mockUrl}/${providerId}/token`,
    userInfoUrl: `${mockUrl}/${providerId}/userinfo`,
    scopes: ['openid', 'email', 'profile'],
    pkce: true,
  }));
}
