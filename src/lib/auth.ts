import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { passkey } from '@better-auth/passkey';
import { apiKey } from '@better-auth/api-key';
import { sso } from '@better-auth/sso';
import { oauthProvider } from '@better-auth/oauth-provider';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { jwt } from 'better-auth/plugins/jwt';
import { genericOAuth, multiSession, testUtils } from 'better-auth/plugins';
import type { Db } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import { sendPasswordResetEmail } from '@karasu-lab/utils/email';
import { getAuthConfig } from '../config';
import { deleteFirebaseUser, updateFirebaseUser } from './firebase';
import { ensureFirebaseLink, getLinkedFirebaseUid } from './firebase-link';
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
    sso({
      // The organization plugin is not installed in this monorepo, so SSO
      // providers cannot be linked to an organization and provisioning into
      // one must stay off; providers are matched by email domain instead.
      organizationProvisioning: { disabled: true },
      saml: {
        // Accept unsolicited SAML responses so users can also start from
        // their IdP's dashboard (Okta, Entra ID, ...). SP-initiated flows
        // keep the plugin's default InResponseTo validation.
        allowIdpInitiated: true,
        // IdP-initiated flows carry no callback URL of their own, so send
        // them to the SSO site's sign-in page, which continues to the
        // default destination once it sees the session — the same contract
        // as auth.karasu256.com's sign-in page.
        idpInitiatedCallbackUrl: `${env.SSO_UI_URL}/sign-in`,
      },
    }),
    ...(mockOAuthUrl ? [genericOAuth({ config: getMockOAuthProviders(mockOAuthUrl) })] : []),
  ];
}

/**
 * Everything except `plugins`, shared by both instances so they cannot drift
 * apart.
 *
 * The database is the single source of truth for sign-in: better-auth owns
 * user ids, and Firebase is linked loosely through the `firebase_user` table
 * (see `firebase-link.ts`). No hook may fail an authentication flow because
 * Firebase or Neon Auth is unreachable — both are best-effort mirrors.
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
        oauthResource: schema.oauthResources,
        oauthClientResource: schema.oauthClientResources,
        oauthClientAssertion: schema.oauthClientAssertions,
        passkey: schema.passkeys,
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
          after: async (user) => {
            // Start the Firebase link unlinked; it is established lazily at
            // sign-in by ensureFirebaseLink. Recorded failure-free so user
            // creation never depends on the link table being reachable.
            try {
              await db.insert(schema.firebaseUsers).values({ userId: user.id }).onConflictDoNothing();
            } catch (error) {
              console.error(`Failed to record firebase_user row for user ${user.id}`, error);
            }
            // Neon Auth only mirrors the user id; the database is the source
            // of truth, so a sync failure must not fail sign-up either.
            try {
              await syncUserToNeonAuth(env, user);
            } catch (error) {
              console.error(`Failed to sync user ${user.id} to Neon Auth`, error);
            }
          },
        },
        update: {
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
          after: (session) => ensureFirebaseLink(env, db, session.userId),
        },
      },
    },
    user: {
      deleteUser: {
        enabled: true,
        // Runs while the firebase_user row still exists (it cascades with
        // the user row), and never blocks deletion on a Firebase failure.
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
        },
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
