import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { passkey } from '@better-auth/passkey';
import { apiKey } from '@better-auth/api-key';
import { sso } from '@better-auth/sso';
import { oauthDeviceAuthorization, oauthProvider } from '@better-auth/oauth-provider';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { jwt } from 'better-auth/plugins/jwt';
import { genericOAuth, multiSession, testUtils } from 'better-auth/plugins';
import type { Db } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import { sendPasswordResetEmail } from '@karasu-lab/utils/email';
import { getAuthConfig } from '../config';
import { assertNoDeviceSessionConflict } from './device-session-conflict';
import { deleteFirebaseUser, updateFirebaseUser } from './firebase';
import { ensureFirebaseLink, getLinkedFirebaseUid } from './firebase-link';
import { getMockOAuthProviders, getMockOAuthUrl } from './mock-oauth';
import { syncUserToNeonAuth } from './neon-auth';
import { SESSION_SOURCE_HEADER, recordSessionSource } from './session-source';

function createPlugins(env: Env) {
  const { webauthn } = getAuthConfig(env);
  const mockOAuthUrl = getMockOAuthUrl(env);

  return [
    jwt(),
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
      refreshTokenReuseInterval: 30,
    }),
    passkey({
      rpID: webauthn.rpId,
      rpName: webauthn.rpName,
      origin: webauthn.expectedOrigins,
    }),
    multiSession({ maximumSessions: 5 }),
    oauthDeviceAuthorization({ verificationUri: `${env.AUTH_UI_URL}/device` }),
    apiKey({ defaultPrefix: 'ksk_', rateLimit: { enabled: false } }),
    sso({
      organizationProvisioning: { disabled: true },
      saml: {
        allowIdpInitiated: true,
        idpInitiatedCallbackUrl: `${env.SSO_UI_URL}/sign-in`,
      },
    }),
    ...(mockOAuthUrl ? [genericOAuth({ config: getMockOAuthProviders(mockOAuthUrl) })] : []),
  ];
}

function createAuthOptions(env: Env, db: Db) {
  const { trustedOrigins } = getAuthConfig(env);
  const mockOAuthUrl = getMockOAuthUrl(env);

  return {
    database: drizzleAdapter(db, {
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
        trustedProviders: ['google', 'github', 'microsoft'],
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
    advanced: {
      crossSubDomainCookies: {
        enabled: Boolean(env.BASE_DOMAIN),
        domain: env.BASE_DOMAIN,
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            return { data: { ...user, image: null } };
          },
          after: async (user) => {
            try {
              await db.insert(schema.firebaseUsers).values({ userId: user.id }).onConflictDoNothing();
            } catch (error) {
              console.error(`Failed to record firebase_user row for user ${user.id}`, error);
            }
            try {
              await syncUserToNeonAuth(env, user);
            } catch (error) {
              console.error(`Failed to sync user ${user.id} to Neon Auth`, error);
            }
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
          after: async (user) => {
            const update: { displayName?: string; photoURL?: string } = {};
            if (user.name) update.displayName = user.name as string;
            if (user.image) update.photoURL = user.image as string;
            if (Object.keys(update).length === 0) return;
            const firebaseUid = await getLinkedFirebaseUid(db, user.id).catch(() => null);
            if (!firebaseUid) return;
            try {
              await updateFirebaseUser(env, firebaseUid, update);
            } catch (error) {
              console.error(`Failed to update Firebase user for user ${user.id}`, error);
            }
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
            await recordSessionSource(db, session, {
              path: context?.path ?? null,
              userAgent: context?.headers?.get('user-agent') ?? null,
              explicit: context?.headers?.get(SESSION_SOURCE_HEADER) ?? null,
            });
            await ensureFirebaseLink(env, db, session.userId);
          },
        },
      },
    },
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          const firebaseUid = await getLinkedFirebaseUid(db, user.id).catch(() => null);
          if (!firebaseUid) return;
          try {
            await deleteFirebaseUser(env, firebaseUid);
          } catch (error) {
            console.error(`Failed to delete Firebase user for user ${user.id}`, error);
          }
        },
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
  return betterAuth({ ...createAuthOptions(env, db), plugins: createPlugins(env) });
}

export function createTestAuth(env: Env, db: Db) {
  return betterAuth({ ...createAuthOptions(env, db), plugins: [...createPlugins(env), testUtils()] });
}

export type Auth = ReturnType<typeof createAuth>;
