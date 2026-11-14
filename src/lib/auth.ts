import { waitUntil } from 'cloudflare:workers';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { passkey } from '@better-auth/passkey';
import { apiKey } from '@better-auth/api-key';
import { sso } from '@better-auth/sso';
import { oauthDeviceAuthorization, oauthProvider } from '@better-auth/oauth-provider';
import { jwt, type JwtOptions } from 'better-auth/plugins/jwt';
import { customSession, genericOAuth, multiSession, organization, testUtils } from 'better-auth/plugins';
import type { Db } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import { sendPasswordResetEmail } from '@karasu-lab/utils/email';
import { getAuthConfig } from '../config';
import { FirebaseDeleteUserWork, FirebaseLinkUserWork, NeonAuthSyncUserWork, runBatchWorks } from './batch-works';
import { assertNoDeviceSessionConflict } from './device-session-conflict';
import { getLinkedFirebaseUid } from './firebase-link';
import { githubAppInstallationPlugin } from './github-app-installation';
import { getGithubOAuthProviders, GITHUB_APP_PROVIDER_ID, SIGNING_KEY_PROVIDER_ID } from './github-providers';
import { getMockOAuthProviders, getMockOAuthUrl } from './mock-oauth';
import { oauthClientRedisAdapter } from './oauth-client-adapter';
import { ActiveSessionDeleteRepository } from './redis/active-session-repositories';
import { JwksCreateRepository, JwksGetRepository } from './redis/jwks-repositories';
import { redisSecondaryStorage } from './redis-storage';
import { sessionJwtHeaderPlugin } from './session-jwt';
import { SessionSourceStore } from './session-source';
import { tenantTypePlugin } from './tenant-type';

function createPlugins(env: Env, db: Db) {
  const { webauthn } = getAuthConfig(env);
  const mockOAuthUrl = getMockOAuthUrl(env);
  const oauthProviders = mockOAuthUrl ? getMockOAuthProviders(mockOAuthUrl) : getGithubOAuthProviders(env);

  const jwtOptions = {
    adapter: {
      getJwks: async (ctx) =>
        (await new JwksGetRepository(env).get()) ??
        (await new JwksCreateRepository(env).create(await ctx.context.adapter.findMany({ model: 'jwks' }))),
    },
  } satisfies JwtOptions;

  return [
    jwt({ ...jwtOptions, disableSettingJwtHeader: true }),
    sessionJwtHeaderPlugin(env, jwtOptions),
    oauthProvider({
      loginPage: `${env.AUTH_UI_URL}/sign-in`,
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
      ],
      resources: [env.MCP_URL],
      clientRegistrationAllowedResources: [env.MCP_URL],
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      accessTokenExpiresIn: 15 * 60,
      customAccessTokenClaims: ({ user }) =>
        user ? { email: user.email, name: user.name, picture: user.image ?? null } : {},
      refreshTokenReuseInterval: 30,
    }),
    passkey({
      rpID: webauthn.rpId,
      rpName: webauthn.rpName,
      origin: webauthn.expectedOrigins,
    }),
    multiSession({ maximumSessions: 5 }),
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

function createAuthOptions(env: Env, db: Db) {
  const { trustedOrigins } = getAuthConfig(env);
  const mockOAuthUrl = getMockOAuthUrl(env);

  return {
    secondaryStorage: redisSecondaryStorage(env),
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
      },
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins,
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        trustedProviders: ['google', 'github', 'microsoft', GITHUB_APP_PROVIDER_ID, SIGNING_KEY_PROVIDER_ID],
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
            await new NeonAuthSyncUserWork(env, db).enqueue({ id: user.id, email: user.email ?? null, name: user.name ?? null });
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
              session.userId,
            );
          },
          after: async (session, context) => {
            await new SessionSourceStore(env, db).record(session, {
              path: context?.path ?? null,
              params: context?.params ?? null,
            });
            await new ActiveSessionDeleteRepository(env).delete(session.userId);
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
    socialProviders: mockOAuthUrl
      ? {}
      : {
          google: {
            clientId: env.GOOGLE_CLIENT_ID as string,
            clientSecret: env.GOOGLE_CLIENT_SECRET as string,
            disableImplicitSignUp: false,
          },
          github: {
            clientId: env.GITHUB_CLIENT_ID as string,
            clientSecret: env.GITHUB_CLIENT_SECRET as string,
            disableImplicitSignUp: false,
          },
          microsoft: {
            clientId: env.MICROSOFT_CLIENT_ID as string,
            clientSecret: env.MICROSOFT_CLIENT_SECRET as string,
            tenantId: 'consumers',
            disableProfilePhoto: true,
            prompt: 'select_account',
            disableImplicitSignUp: false,
          },
        },
  } satisfies BetterAuthOptions;
}

export function createAuth(env: Env, db: Db) {
  return betterAuth({ ...createAuthOptions(env, db), plugins: createPlugins(env, db) });
}

export function createTestAuth(env: Env, db: Db) {
  return betterAuth({ ...createAuthOptions(env, db), plugins: [...createPlugins(env, db), testUtils()] });
}

export type Auth = ReturnType<typeof createAuth>;
