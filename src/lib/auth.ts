import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { passkey } from '@better-auth/passkey';
import { apiKey } from '@better-auth/api-key';
import { oauthProvider } from '@better-auth/oauth-provider';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { jwt } from 'better-auth/plugins/jwt';
import { genericOAuth, multiSession, testUtils } from 'better-auth/plugins';
import type { Db } from '@Hashibutogarasu/db/create-db';
import * as schema from '@Hashibutogarasu/db/schema';
import { sendPasswordResetEmail } from '@Hashibutogarasu/utils/email';
import { getAuthConfig } from '../config';
import { createFirebaseUser, deleteFirebaseUser, updateFirebaseUser } from './firebase';
import { getMockOAuthProviders, getMockOAuthUrl } from './mock-oauth';
import { syncUserToNeonAuth } from './neon-auth';

/** The plugins shared by the production instance and the test-only instance. */
function createPlugins(env: Env) {
  const { webauthn } = getAuthConfig(env);
  const mockOAuthUrl = getMockOAuthUrl(env);

  return [
    jwt(),
    oauthProvider({
      loginPage: `${env.AUTH_UI_URL}/sign-in`,
      consentPage: `${env.AUTH_UI_URL}/oauth/consent`,
      scopes: ['openid', 'profile', 'email', 'offline_access', 'read:profile', 'write:profile'],
      allowDynamicClientRegistration: false,
      accessTokenExpiresIn: 15 * 60,
    }),
    passkey({
      rpID: webauthn.rpId,
      rpName: webauthn.rpName,
      origin: webauthn.expectedOrigins,
    }),
    multiSession({ maximumSessions: 5 }),
    apiKey({ defaultPrefix: 'ksk_', rateLimit: { enabled: false } }),
    ...(mockOAuthUrl ? [genericOAuth({ config: getMockOAuthProviders(mockOAuthUrl) })] : []),
  ];
}

/**
 * Everything except `plugins`, shared by both instances so they cannot drift
 * apart.
 *
 * Every user id equals its Firebase UID, because every table and CDN storage
 * path in this monorepo is keyed by it; the `before` create hook therefore
 * provisions the Firebase user first and adopts its UID.
 */
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
        passkey: schema.passkeys,
        apikey: schema.apiKeys,
      },
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins,
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        trustedProviders: ['google', 'github'],
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
            const uid = await createFirebaseUser(env, {
              email: user.email || undefined,
              emailVerified: user.emailVerified,
              displayName: user.name || undefined,
            });
            return { data: { ...user, id: uid } };
          },
          after: (user) => syncUserToNeonAuth(env, user),
        },
        update: {
          after: async (user) => {
            const update: { displayName?: string; photoURL?: string } = {};
            if (user.name) update.displayName = user.name as string;
            if (user.image) update.photoURL = user.image as string;
            if (Object.keys(update).length === 0) return;
            await updateFirebaseUser(env, user.id, update);
          },
        },
      },
    },
    user: {
      deleteUser: {
        enabled: true,
        afterDelete: (user) => deleteFirebaseUser(env, user.id),
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
        },
    disabledPaths: ['/token'],
  } satisfies BetterAuthOptions;
}

/**
 * Builds the better-auth instance for one request. Workers cannot share I/O
 * objects such as database connections between requests, so the instance and
 * the `db` it wraps are created per request.
 */
export function createAuth(env: Env, db: Db) {
  return betterAuth({ ...createAuthOptions(env, db), plugins: createPlugins(env) });
}

/**
 * Test-only instance: the production configuration plus `testUtils`. It is
 * kept separate because mixing `testUtils` into production would expose
 * privileged helpers (`ctx.test.createUser`, `.login`, `.deleteUser`, ...) on
 * that instance's context.
 */
export function createTestAuth(env: Env, db: Db) {
  return betterAuth({ ...createAuthOptions(env, db), plugins: [...createPlugins(env), testUtils()] });
}

export type Auth = ReturnType<typeof createAuth>;
