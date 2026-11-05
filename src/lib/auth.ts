import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { passkey } from '@better-auth/passkey';
import { apiKey } from '@better-auth/api-key';
import { sso } from '@better-auth/sso';
import { oauthProvider } from '@better-auth/oauth-provider';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { jwt } from 'better-auth/plugins/jwt';
import { deviceAuthorization, genericOAuth, multiSession, testUtils } from 'better-auth/plugins';
import type { Db } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import { sendPasswordResetEmail } from '@karasu-lab/utils/email';
import { getAuthConfig } from '../config';
import { assertNoDeviceSessionConflict } from './device-session-conflict';
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
    deviceAuthorization({ verificationUri: `${env.AUTH_UI_URL}/device` }),
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
            // The account icon stored in the database is the single source
            // of truth and changes only when the user uploads one
            // themselves (through the profile image endpoint, which writes
            // the database directly). A provider profile must never seed
            // it: accounts created from an external provider's sign-up
            // start with no icon, whatever picture the provider returned.
            return { data: { ...user, image: null } };
          },
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
          before: async (user, context) => {
            // The better-auth user row is the single source of truth for
            // the profile (name and icon), and the user's own profile edit
            // through the update-user endpoint is how it is maintained:
            // let that one write through. Every other auth-layer update
            // carrying profile fields comes from an external provider flow
            // (sign-in, account linking, SSO), where the provider's profile
            // must never overwrite the stored one, so drop both fields
            // there and let the provider flow only issue its session. An
            // update that consisted solely of profile fields becomes a
            // no-op.
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
          microsoft: {
            clientId: env.MICROSOFT_CLIENT_ID as string,
            clientSecret: env.MICROSOFT_CLIENT_SECRET as string,
            // The app registration is limited to personal Microsoft
            // accounts (the accounts that hold Xbox Live / Minecraft
            // licenses), so the authority must be the consumers tenant:
            // the default `common` tenant is rejected for this client.
            tenantId: 'consumers',
            // No `XboxLive.signin` scope here: a code issued for two
            // resources cannot be redeemed without a scope parameter,
            // which better-auth does not send (AADSTS70011). Xbox
            // consent uses the dedicated flow in `routes/xbox.ts`.
            // The profile photo is not fetched either: better-auth
            // would embed it as a data URL that overflows
            // `users.image` (varchar(2048)) on link.
            disableProfilePhoto: true,
            prompt: 'select_account',
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
