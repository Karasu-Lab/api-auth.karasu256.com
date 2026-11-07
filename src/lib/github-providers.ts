import type { GenericOAuthConfig, GenericOAuthUserInfo } from 'better-auth/plugins';

export const GITHUB_APP_PROVIDER_ID = 'github-app';
export const SIGNING_KEY_PROVIDER_ID = 'github-signing-key';

const GITHUB_AUTHORIZATION_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_INFO_URL = 'https://api.github.com/user';

function mapGithubProfile(profile: GenericOAuthUserInfo) {
  return { image: typeof profile.avatar_url === 'string' ? profile.avatar_url : undefined };
}

export function getGithubOAuthProviders(env: Env): GenericOAuthConfig[] {
  const providers: GenericOAuthConfig[] = [];
  if (env.GH_APP_CLIENT_ID && env.GH_APP_CLIENT_SECRET) {
    providers.push({
      providerId: GITHUB_APP_PROVIDER_ID,
      clientId: env.GH_APP_CLIENT_ID,
      clientSecret: env.GH_APP_CLIENT_SECRET,
      authorizationUrl: GITHUB_AUTHORIZATION_URL,
      tokenUrl: GITHUB_TOKEN_URL,
      userInfoUrl: GITHUB_USER_INFO_URL,
      disableImplicitSignUp: true,
      mapProfileToUser: mapGithubProfile,
    });
  }
  if (env.GH_OATH_CLIENT_ID && env.GH_OAUTH_CLIENT_SECRET) {
    providers.push({
      providerId: SIGNING_KEY_PROVIDER_ID,
      clientId: env.GH_OATH_CLIENT_ID,
      clientSecret: env.GH_OAUTH_CLIENT_SECRET,
      authorizationUrl: GITHUB_AUTHORIZATION_URL,
      tokenUrl: GITHUB_TOKEN_URL,
      userInfoUrl: GITHUB_USER_INFO_URL,
      scopes: ['admin:ssh_signing_key'],
      disableImplicitSignUp: true,
      mapProfileToUser: mapGithubProfile,
    });
  }
  return providers;
}
