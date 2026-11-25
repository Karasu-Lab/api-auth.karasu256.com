import type { BetterAuthOptions } from 'better-auth';
import { getMockOAuthUrl } from './mock-oauth';
import { oauthProxyRedirectURI } from './oauth-proxy';
import { getXUserInfo } from './x-user-info';

export function createSocialProviders(env: Env) {
  if (getMockOAuthUrl(env)) return {};

  return {
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            redirectURI: oauthProxyRedirectURI(env, 'google'),
            disableImplicitSignUp: false,
          },
        }
      : {}),
    ...(env.GH_CLIENT_ID && env.GH_CLIENT_SECRET
      ? {
          github: {
            clientId: env.GH_CLIENT_ID,
            clientSecret: env.GH_CLIENT_SECRET,
            redirectURI: oauthProxyRedirectURI(env, 'github'),
            disableImplicitSignUp: false,
          },
        }
      : {}),
    ...(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET
      ? {
          microsoft: {
            clientId: env.MICROSOFT_CLIENT_ID,
            clientSecret: env.MICROSOFT_CLIENT_SECRET,
            redirectURI: oauthProxyRedirectURI(env, 'microsoft'),
            tenantId: 'consumers',
            disableProfilePhoto: true,
            prompt: 'select_account',
            disableImplicitSignUp: false,
          },
        }
      : {}),
    ...(env.X_CLIENT_ID && env.X_CLIENT_SECRET
      ? {
          twitter: {
            clientId: env.X_CLIENT_ID,
            clientSecret: env.X_CLIENT_SECRET,
            redirectURI: oauthProxyRedirectURI(env, 'twitter'),
            getUserInfo: getXUserInfo,
            disableImplicitSignUp: false,
          },
        }
      : {}),
    ...(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET
      ? {
          discord: {
            clientId: env.DISCORD_CLIENT_ID,
            clientSecret: env.DISCORD_CLIENT_SECRET,
            redirectURI: oauthProxyRedirectURI(env, 'discord'),
            disableImplicitSignUp: false,
          },
        }
      : {}),
  } satisfies BetterAuthOptions['socialProviders'];
}
