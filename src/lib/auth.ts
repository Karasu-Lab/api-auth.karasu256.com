import { waitUntil } from 'cloudflare:workers';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { emailChallenge } from 'better-auth-email-challenge';
import { passkey } from '@better-auth/passkey';
import { apiKey } from '@better-auth/api-key';
import { sso } from '@better-auth/sso';
import { oauthDeviceAuthorization, oauthProvider } from '@better-auth/oauth-provider';
import { jwt, type JwtOptions } from 'better-auth/plugins/jwt';
import { customSession, genericOAuth, multiSession, oneTimeToken, organization, testUtils } from 'better-auth/plugins';
import type { Db } from '../db/create-db';
import * as schema from '../db/schema';
import { sendPasswordResetEmail } from '@karasu-lab/utils/email';
import { getAuthConfig } from '../config';
import { emailChallenges } from '../db/schema/email-challenges';
import { sendChallengeEmail } from './challenge-email';
import { FirebaseDeleteUserWork, FirebaseLinkUserWork, RedisSessionCleanupWork, runBatchWorks } from './batch-works';
import { assertNoDeviceSessionConflict } from './device-session-conflict';
import { getLinkedFirebaseUid } from './firebase-link';
import { githubAppInstallationPlugin } from './github-app-installation';
import { getGithubOAuthProviders, GITHUB_APP_PROVIDER_ID, SIGNING_KEY_PROVIDER_ID } from './github-providers';
import { getMockOAuthProviders, getMockOAuthUrl } from './mock-oauth';
import { oauthClientRedisAdapter } from './oauth-client-adapter';
import { oneTimeTokenStateOptions, oneTimeTokenStatePlugin } from './one-time-token-state';
import { ActiveSessionDeleteRepository } from './redis/active-session-repositories';
import { readJwks } from './redis/jwks-repositories';
import { SessionExpiryCreateRepository, SessionExpiryRevokeRepository } from './redis/session-expiry-repositories';
import { redisSecondaryStorage } from './redis-storage';
import { sessionJwtHeaderPlugin } from './session-jwt';
import { SessionSourceStore } from './session-source';
import { createSocialProviders } from './social-providers';
import { refreshLinkableProviderClients } from './linkable-providers';
import { OAuthSignInFlow } from './oauth-sign-in-flow';
import { tenantTypePlugin } from './tenant-type';
import { sendVerificationEmail } from './verification-email';

function createPlugins(env: Env, db: Db) {
  const { webauthn } = getAuthConfig(env);
  const mockOAuthUrl = getMockOAuthUrl(env);
  const oauthProviders = mockOAuthUrl ? getMockOAuthProviders(mockOAuthUrl) : getGithubOAuthProviders(env, new OAuthSignInFlow());

  const jwtOptions = {
    jwks: { keyPairConfig: { alg: 'RS256', modulusLength: 2048 } },
    adapter: {
      getJwks: async (ctx) => {
        const keys = await readJwks(env, () => ctx.context.adapter.findMany({ model: 'jwks' }));
        return keys.some((key) => key.alg === 'RS256') ? [...keys].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()) : [];
      },
    },
  } satisfies JwtOptions;

  return [
    jwt({ ...jwtOptions, disableSettingJwtHeader: true }),
    sessionJwtHeaderPlugin(env, jwtOptions),
    oauthProvider({
      loginPage: `${env.SSO_UI_URL}/sign-in`,
      consentPage: `${env.AUTH_UI_URL}/oauth/consent`,
      scopes: [
        'openid',
        'profile',
        'email',
        'offline_access',
        'read:users.profile',
        'write:users.profile',
        'read:github.user',
        'read:github.avatar',
        'read:github.repositories',
        'delete:users.avatar',
      ],
      resources: [env.MCP_URL],
      clientRegistrationAllowedResources: [env.MCP_URL],
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      accessTokenExpiresIn: 15 * 60,
      customAccessTokenClaims: ({ user }) => (user ? { email: user.email, name: user.name, picture: user.image ?? null } : {}),
      refreshTokenReuseInterval: 30,
    }),
    passkey({
      rpID: webauthn.rpId,
      rpName: webauthn.rpName,
      origin: webauthn.expectedOrigins,
    }),
    emailChallenge({
      otpLength: 6,
      disableSignUp: true,
      sendChallengeEmail: ({ email, otp, challenge }) => sendChallengeEmail(env, { email, otp, expiresAt: challenge.expiresAt }),
    }),
    multiSession({ maximumSessions: 5 }),
    oneTimeToken(oneTimeTokenStateOptions(env)),
    oneTimeTokenStatePlugin(env),
    organization({ teams: { enabled: true } }),
    oauthDeviceAuthorization({ verificationUri: `${env.AUTH_UI_URL}/device` }),
    apiKey({ defaultPrefix: 'ksk_', rateLimit: { enabled: false } }),
    sso({
      organizationProvisioning: { disabled: true },
      saml: {
        allowIdpInitiated: true,
        idpInitiatedCallbackUrl: `${env.SSO_UI_URL}/sign-in`,
      },
    }),
    ...(oauthProviders.length > 0 ? [genericOAuth({ config: oauthProviders })] : []),
    githubAppInstallationPlugin(env),
    tenantTypePlugin(env),
    customSession(async ({ user, session }) => ({
      user,
      session,
      source: await new SessionSourceStore(env, db).get(session),
    })),
  ];
}

async function createAuthOptions(env: Env, db: Db) {
  const { trustedOrigins } = getAuthConfig(env);

  return {
    secondaryStorage: await redisSecondaryStorage(env),
    database: oauthClientRedisAdapter(env, db, {
      provider: 'pg',
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
        jwks: schema.jwks,
        oauthClient: schema.oauthClients,
        oauthRefreshToken: schema.oauthRefreshTokens,
        oauthAccessToken: schema.oauthAccessTokens,
        oauthConsent: schema.oauthConsents,
        oauthResource: schema.oauthResources,
        oauthClientResource: schema.oauthClientResources,
        oauthClientAssertion: schema.oauthClientAssertions,
        passkey: schema.passkeys,
        organization: schema.organizations,
        member: schema.members,
        invitation: schema.invitations,
        team: schema.teams,
        teamMember: schema.teamMembers,
        deviceCode: schema.deviceCodes,
        apikey: schema.apiKeys,
        ssoProvider: schema.ssoProviders,
        emailChallenge: emailChallenges,
      },
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins,
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        trustedProviders: ['google', 'github', 'microsoft', 'twitter', 'discord', GITHUB_APP_PROVIDER_ID, SIGNING_KEY_PROVIDER_ID],
        allowDifferentEmails: true,
        updateUserInfoOnLink: true,
      },
    },
    emailAndPassword: {
      enabled: true,
      sendResetPassword: async ({ user, url }) => {
        await sendPasswordResetEmail({ apiKey: env.RESEND_API_KEY, from: env.RESEND_FROM_EMAIL, to: user.email, resetUrl: url });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendVerificationEmail(env, { email: user.email, url });
      },
    },
    session: {
      storeSessionInDatabase: true,
      cookieCache: {
        enabled: true,
      },
    },
    verification: {
      storeInDatabase: true,
    },
    rateLimit: {
      storage: 'memory',
    },
    advanced: {
      cookiePrefix: env.APP_ENV,
      crossSubDomainCookies: {
        enabled: Boolean(env.BASE_DOMAIN),
        domain: env.BASE_DOMAIN,
      },
      backgroundTasks: {
        handler: waitUntil,
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            return { data: { ...user, image: null } };
          },
          after: async (user, context) => {
            await new FirebaseLinkUserWork(env, db).enqueue({ userId: user.id });
            context?.context.runInBackground(runBatchWorks(env));
          },
        },
        update: {
          before: async (user, context) => {
            if (!('name' in user) && !('image' in user)) return;
            if (context?.path === '/update-user') return;
            const rest = { ...user };
            delete rest.name;
            delete rest.image;
            if (Object.keys(rest).length === 0) return false;
            return { data: { ...rest, name: undefined, image: undefined } };
          },
          after: async (user, context) => {
            if (!user.name && !user.image) return;
            await new FirebaseLinkUserWork(env, db).enqueue({ userId: user.id });
            context?.context.runInBackground(runBatchWorks(env));
          },
        },
        delete: {
          before: async (user, context) => {
            const firebaseUid = await getLinkedFirebaseUid(db, user.id).catch(() => null);
            if (!firebaseUid) return;
            await new FirebaseDeleteUserWork(env, db).enqueue({ firebaseUid });
            context?.context.runInBackground(runBatchWorks(env));
          },
        },
      },
      account: {
        create: {
          after: async (account, context) => {
            if (account.providerId !== 'google') return;
            await new FirebaseLinkUserWork(env, db).enqueue({ userId: account.userId });
            context?.context.runInBackground(runBatchWorks(env));
          },
        },
        update: {
          after: async (account, context) => {
            if (account.providerId !== 'google' || !account.userId) return;
            await new FirebaseLinkUserWork(env, db).enqueue({ userId: account.userId });
            context?.context.runInBackground(runBatchWorks(env));
          },
        },
      },
      session: {
        create: {
          before: async (session, context) => {
            if (!context) return;
            await assertNoDeviceSessionConflict(
              {
                cookieHeader: context.headers?.get('cookie') ?? null,
                getSignedCookie: (name) => context.getSignedCookie(name, context.context.secret),
                findSessions: (tokens) => context.context.internalAdapter.findSessions(tokens, { onlyActiveSessions: true }),
              },
              session.userId
            );
          },
          after: async (session, context) => {
            const provider = (context?.body as { provider?: unknown } | undefined)?.provider;
            await new SessionSourceStore(env, db).record(session, {
              path: context?.path ?? null,
              params: {
                ...(context?.params ?? {}),
                ...(typeof provider === 'string' ? { provider } : {}),
              },
            });
            await new ActiveSessionDeleteRepository(env).delete(session.userId);
            await new SessionExpiryCreateRepository(env).create(session.id, session.expiresAt);
            const cleanup = new RedisSessionCleanupWork(env, db);
            cleanup.scheduledAt = session.expiresAt;
            await cleanup.enqueue({ sessionId: session.id, userId: session.userId });
            context?.context.runInBackground(runBatchWorks(env));
          },
        },
        update: {
          after: async (session) => {
            if (session.id && session.expiresAt) await new SessionExpiryCreateRepository(env).create(session.id, session.expiresAt);
          },
        },
        delete: {
          after: async (session, context) => {
            await new SessionExpiryRevokeRepository(env).revoke(session.id);
            await new RedisSessionCleanupWork(env, db).enqueue({ sessionId: session.id, userId: session.userId });
            context?.context.runInBackground(runBatchWorks(env));
          },
        },
      },
    },
    user: {
      deleteUser: {
        enabled: true,
      },
    },
    onAPIError: {
      errorURL: `${env.AUTH_UI_URL}/oauth/error`,
    },
    socialProviders: createSocialProviders(env, new OAuthSignInFlow()),
  } satisfies BetterAuthOptions;
}

export async function createAuth(env: Env, db: Db) {
  refreshLinkableProviderClients(env);
  return betterAuth({ ...(await createAuthOptions(env, db)), plugins: createPlugins(env, db) });
}

export async function createTestAuth(env: Env, db: Db) {
  return betterAuth({ ...(await createAuthOptions(env, db)), plugins: [...createPlugins(env, db), testUtils()] });
}

export type Auth = Awaited<ReturnType<typeof createAuth>>;
