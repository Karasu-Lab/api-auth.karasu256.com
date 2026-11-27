import type { BetterAuthOptions } from 'better-auth';
import { z } from 'zod';
import { OAuthSignInFlow } from './oauth-sign-in-flow';
import { getMockOAuthUrl } from './mock-oauth';
import { oauthProxyRedirectURI } from './oauth-proxy';
import { getXUserInfo } from './x-user-info';

function googleClientIds(env: Env): string | string[] {
  const primary = env.GOOGLE_CLIENT_ID as string;
  if (!env.GOOGLE_ADDITIONAL_CLIENT_IDS) return primary;
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.GOOGLE_ADDITIONAL_CLIENT_IDS);
  } catch {
    throw new Error('GOOGLE_ADDITIONAL_CLIENT_IDS must be a JSON array of non-empty strings');
  }
  const result = z.array(z.string().min(1)).safeParse(parsed);
  if (!result.success) throw new Error('GOOGLE_ADDITIONAL_CLIENT_IDS must be a JSON array of non-empty strings');
  const clientIds = [primary, ...result.data.filter((clientId) => clientId !== primary)];
  return clientIds.length > 1 ? clientIds : primary;
}

export function createSocialProviders(env: Env, signInFlow?: OAuthSignInFlow) {
  if (getMockOAuthUrl(env)) return {};

  return {
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: googleClientIds(env),
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
            ...(signInFlow ? { mapProfileToUser: signInFlow.socialProfileMapper('github') } : {}),
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
