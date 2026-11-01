import { decryptOAuthToken, setTokenUtil } from 'better-auth/oauth2';
import type { AuthContext } from '@better-auth/core';
import type { OAuth2Tokens } from '@better-auth/core/oauth2';
import type { Auth } from './auth';
import { getMinecraftProfile, loginToMinecraft } from './minecraft';
import {
  authenticateXboxLive,
  authorizeXsts,
  getXboxProfile,
  refreshMicrosoftTokens,
  MINECRAFT_RELYING_PARTY,
  XBOX_RELYING_PARTY,
} from './xbox-live';
import { XBOX_PROVIDER_ID } from './xbox-link';

export interface ProviderProfile {
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export interface ProviderProfileOptions {
  microsoftClientId?: string;
  microsoftClientSecret?: string;
}

export const DERIVED_PROVIDER_IDS = ['xbox', 'minecraft'] as const;

type SocialProvider = AuthContext['socialProviders'][number];

interface StoredAccount {
  id: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  idToken?: string | null;
}

/**
 * One external provider's profile sync: how the provider exchanges its
 * stored refresh token for fresh tokens, and how it fetches its
 * current profile with a token set. Every provider's profile is synced
 * through this interface by {@link syncProviderProfile}.
 */
interface ProviderProfileSync {
  refreshTokens(refreshToken: string): Promise<OAuth2Tokens | null>;
  fetchProfile(tokens: OAuth2Tokens): Promise<ProviderProfile | null>;
}

async function decryptStoredTokens(ctx: AuthContext, account: StoredAccount): Promise<OAuth2Tokens | null> {
  try {
    return {
      accessToken: account.accessToken ? await decryptOAuthToken(account.accessToken, ctx) : undefined,
      refreshToken: account.refreshToken ? await decryptOAuthToken(account.refreshToken, ctx) : undefined,
      idToken: account.idToken ? await decryptOAuthToken(account.idToken, ctx) : undefined,
    };
  } catch {
    return null;
  }
}

async function persistRefreshedTokens(ctx: AuthContext, accountId: string, refreshed: OAuth2Tokens): Promise<void> {
  const data: {
    accessToken: string | null;
    refreshToken?: string | null;
    idToken?: string | null;
    accessTokenExpiresAt?: Date;
  } = { accessToken: (await setTokenUtil(refreshed.accessToken, ctx)) ?? null };
  if (refreshed.refreshToken !== undefined) data.refreshToken = (await setTokenUtil(refreshed.refreshToken, ctx)) ?? null;
  if (refreshed.idToken !== undefined) data.idToken = (await setTokenUtil(refreshed.idToken, ctx)) ?? null;
  if (refreshed.accessTokenExpiresAt) data.accessTokenExpiresAt = refreshed.accessTokenExpiresAt;
  await ctx.internalAdapter.updateAccount(accountId, data).catch((error) => {
    console.error('Failed to sync the refreshed provider tokens:', error instanceof Error ? error.message : error);
  });
}

/**
 * The flow every provider's profile sync shares: when a refresh token
 * is stored, exchange it for fresh tokens first and sync them back to
 * the account (providers may rotate refresh tokens, so the fresh set
 * must replace the stored one), then fetch the profile with the
 * freshest token set available. A failed refresh falls back to the
 * stored tokens.
 */
async function syncProviderProfile(
  ctx: AuthContext,
  accountId: string,
  stored: OAuth2Tokens,
  sync: ProviderProfileSync
): Promise<ProviderProfile | null> {
  let tokens = stored;
  if (stored.refreshToken) {
    const refreshed = await sync.refreshTokens(stored.refreshToken).catch(() => null);
    if (refreshed?.accessToken) {
      tokens = {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? stored.refreshToken,
        idToken: refreshed.idToken ?? stored.idToken,
      };
      await persistRefreshedTokens(ctx, accountId, refreshed);
    }
  }
  return sync.fetchProfile(tokens);
}

function socialProfileSync(provider: SocialProvider): ProviderProfileSync {
  return {
    async refreshTokens(refreshToken) {
      if (!provider.refreshAccessToken) return null;
      const refreshed = await provider.refreshAccessToken(refreshToken).catch(() => null);
      return refreshed?.accessToken ? refreshed : null;
    },
    async fetchProfile(tokens) {
      const info = await provider
        .getUserInfo({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, idToken: tokens.idToken })
        .catch(() => null);
      if (!info) return null;
      return { name: info.user.name ?? null, email: info.user.email ?? null, avatarUrl: info.user.image ?? null };
    },
  };
}

// Microsoft's profile photo is not part of its user info (embedding it
// once broke account linking), so it is read from Microsoft Graph with
// the same live token the sync refreshed.
function microsoftProfileSync(provider: SocialProvider): ProviderProfileSync {
  const social = socialProfileSync(provider);
  return {
    refreshTokens: social.refreshTokens,
    async fetchProfile(tokens) {
      const profile = await social.fetchProfile(tokens);
      if (!profile) return null;
      if (!profile.avatarUrl && tokens.accessToken) {
        profile.avatarUrl = await getMicrosoftPhotoDataUrl(tokens.accessToken);
      }
      return profile;
    },
  };
}

const SOCIAL_PROFILE_SYNC_FACTORIES: Record<string, (provider: SocialProvider) => ProviderProfileSync> = {
  microsoft: microsoftProfileSync,
};

function microsoftRefreshTokens(options?: ProviderProfileOptions): Pick<ProviderProfileSync, 'refreshTokens'> {
  return {
    async refreshTokens(refreshToken) {
      if (!options?.microsoftClientId || !options?.microsoftClientSecret) return null;
      return refreshMicrosoftTokens(refreshToken, options.microsoftClientId, options.microsoftClientSecret);
    },
  };
}

function xboxProfileSync(options?: ProviderProfileOptions): ProviderProfileSync {
  return {
    ...microsoftRefreshTokens(options),
    async fetchProfile(tokens) {
      if (!tokens.accessToken) return null;
      const xboxLive = await authenticateXboxLive(tokens.accessToken);
      const xsts = await authorizeXsts(xboxLive.token, XBOX_RELYING_PARTY);
      const profile = await getXboxProfile(xsts);
      if (!profile) return null;
      return { name: profile.gamertag, email: null, avatarUrl: profile.avatarUrl };
    },
  };
}

function minecraftProfileSync(options?: ProviderProfileOptions): ProviderProfileSync {
  return {
    ...microsoftRefreshTokens(options),
    async fetchProfile(tokens) {
      if (!tokens.accessToken) return null;
      const xboxLive = await authenticateXboxLive(tokens.accessToken);
      const xsts = await authorizeXsts(xboxLive.token, MINECRAFT_RELYING_PARTY);
      const minecraftToken = await loginToMinecraft(xsts);
      const profile = await getMinecraftProfile(minecraftToken);
      return { name: profile.name, email: null, avatarUrl: profile.skinTextureUrl };
    },
  };
}

/**
 * Fetches a linked provider's current profile (name, email, avatar).
 * better-auth's `account` table only stores tokens, not a denormalized
 * profile snapshot, so the profile is synced fresh on every call
 * through the provider's {@link ProviderProfileSync}.
 *
 * The cast to the generic `AuthContext` is safe: `decryptOAuthToken`
 * only reads `options` and `secretConfig`, which exist independent of
 * the instance's specific `Options` type.
 *
 * Decrypting can throw (better-auth's `isLikelyEncrypted` heuristic
 * misjudges some plaintext tokens, e.g. legacy 40-char hex GitHub
 * tokens, as ciphertext), which is treated like any other unresolvable
 * profile.
 *
 * @returns `null` when the provider isn't linked or its profile can't
 * be resolved. A derived provider (xbox, minecraft) is linked exactly
 * when its Xbox account row exists, so an unresolvable profile there
 * returns an empty profile instead of `null`.
 */
export async function getProviderProfile(
  auth: Auth,
  uid: string,
  providerId: string,
  options?: ProviderProfileOptions
): Promise<ProviderProfile | null> {
  const ctx = (await auth.$context) as unknown as AuthContext;

  if ((DERIVED_PROVIDER_IDS as readonly string[]).includes(providerId)) {
    return getDerivedProviderProfile(ctx, uid, providerId, options);
  }

  const account = (await ctx.internalAdapter.findAccounts(uid)).find((entry) => entry.providerId === providerId);
  if (!account) return null;

  const provider = ctx.socialProviders.find((entry) => entry.id === providerId);
  if (!provider) return null;

  const stored = await decryptStoredTokens(ctx, account);
  if (!stored) return null;

  const createSync = SOCIAL_PROFILE_SYNC_FACTORIES[providerId] ?? socialProfileSync;
  return syncProviderProfile(ctx, account.id, stored, createSync(provider));
}

async function getMicrosoftPhotoDataUrl(accessToken: string): Promise<string | null> {
  const res = await fetch('https://graph.microsoft.com/v1.0/me/photos/48x48/$value', {
    headers: { authorization: `Bearer ${accessToken}` },
  }).catch(() => null);
  if (!res?.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (bytes.length === 0) return null;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return `data:image/jpeg;base64, ${btoa(binary)}`;
}

async function getDerivedProviderProfile(
  ctx: AuthContext,
  uid: string,
  providerId: string,
  options?: ProviderProfileOptions
): Promise<ProviderProfile | null> {
  const account = (await ctx.internalAdapter.findAccounts(uid)).find((entry) => entry.providerId === XBOX_PROVIDER_ID);
  if (!account) return null;

  const stored = await decryptStoredTokens(ctx, account);
  if (!stored) return null;

  const sync = providerId === 'xbox' ? xboxProfileSync(options) : minecraftProfileSync(options);

  // The Xbox account row exists at this point, so the provider is
  // linked; a profile that cannot be resolved (for example an account
  // that owns no Minecraft) yields an empty profile, not null.
  try {
    const profile = await syncProviderProfile(ctx, account.id, stored, sync);
    if (profile) return profile;
  } catch (error) {
    console.error(`Failed to resolve the ${providerId} profile:`, error instanceof Error ? error.message : error);
  }
  return { name: null, email: null, avatarUrl: null };
}
