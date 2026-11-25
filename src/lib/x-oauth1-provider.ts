import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import type { OAuthProvider } from '@better-auth/core/oauth2';
import { getOAuthProxyConfig, oauthProxyRedirectURI, signProxyState } from './oauth-proxy';
import { XRequestTokenCreateRepository, XRequestTokenTakeRepository } from './redis/x-request-token-repositories';
import { fetchXAccessToken, fetchXRequestToken, xAuthenticateUrl, type XConsumer } from './x-oauth1';
import { getXUserInfo } from './x-user-info';

export function xOAuth1Plugin(env: Env, consumer: XConsumer) {
  const provider: OAuthProvider<{ data: { id: string } }> = {
    id: 'twitter',
    name: 'Twitter',
    accountSubject: ({ profile }) => profile.data.id,
    async createAuthorizationURL({ state, redirectURI }) {
      const proxy = getOAuthProxyConfig(env);
      const callbackUrl = new URL(oauthProxyRedirectURI(env, 'twitter') ?? redirectURI);
      callbackUrl.searchParams.set('state', proxy?.secret ? await signProxyState({ ...proxy, secret: proxy.secret }, state) : state);

      const requestToken = await fetchXRequestToken(consumer, callbackUrl.toString());
      if (!requestToken) throw new APIError('BAD_GATEWAY', { message: 'Unable to start X sign-in' });
      await new XRequestTokenCreateRepository(env).create(requestToken.token, requestToken.tokenSecret);
      return xAuthenticateUrl(requestToken.token);
    },
    async validateAuthorizationCode({ code }) {
      const [requestToken, verifier, ...rest] = code.split(':');
      if (!requestToken || !verifier || rest.length) return null;
      const requestTokenSecret = await new XRequestTokenTakeRepository(env).take(requestToken);
      if (!requestTokenSecret) return null;
      const accessToken = await fetchXAccessToken(consumer, requestToken, requestTokenSecret, verifier);
      if (!accessToken) return null;
      return { accessToken: accessToken.token, raw: { oauth_token_secret: accessToken.tokenSecret } };
    },
    async getUserInfo(tokens) {
      const tokenSecret = tokens.raw?.oauth_token_secret;
      if (!tokens.accessToken || typeof tokenSecret !== 'string') return null;
      return getXUserInfo(consumer, tokens.accessToken, tokenSecret);
    },
  };

  return {
    id: 'x-oauth1',
    init: (ctx) => ({ context: { socialProviders: [provider as OAuthProvider, ...ctx.socialProviders] } }),
    hooks: {
      before: [
        {
          matcher: (context: { params?: { id?: string } }) => context.params?.id === 'twitter',
          handler: createAuthMiddleware(async (ctx) => {
            const { oauth_token, oauth_verifier } = ctx.query ?? {};
            if (typeof oauth_token !== 'string' || typeof oauth_verifier !== 'string') return;
            return { context: { query: { ...ctx.query, code: `${oauth_token}:${oauth_verifier}` } } };
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
