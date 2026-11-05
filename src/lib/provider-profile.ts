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
  minecraftAuthEnabled?: boolean;
}

export const DERIVED_PROVIDER_IDS = ['xbox', 'minecraft'] as const;

type SocialProvider = AuthContext['socialProviders'][number];

interface StoredAccount {
  id: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  idToken?: string | null;
  accessTokenExpiresAt?: Date | string | null;
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
      accessTokenExpiresAt: account.accessTokenExpiresAt ? new Date(account.accessTokenExpiresAt) : undefined,
    };
  } catch {
    return null;
  }
}

function hasLiveAccessToken(tokens: OAuth2Tokens): boolean {
  if (!tokens.accessToken || !tokens.accessTokenExpiresAt) return false;
  return tokens.accessTokenExpiresAt.getTime() > Date.now() + 30_000;
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
 * The flow every provider's profile sync shares: a stored access token
 * that is still live is used as is; once it has expired (access tokens
 * are short-lived), the stored refresh token is exchanged for fresh
 * tokens and synced back to the account first (providers may rotate
 * refresh tokens, so the fresh set must replace the stored one), and
 * the profile is fetched with the freshest token set available.
 *
 * Two derived providers (xbox, minecraft) share one account row, so
 * parallel syncs refresh the same rotating refresh token: the sync
 * that loses that race fails its refresh and falls back to the expired
 * stored token. When a fetch fails, the account is therefore re-read
 * and the fetch retried with the tokens the winning sync stored.
 */
async function syncProviderProfile(
  ctx: AuthContext,
  accountId: string,
  stored: OAuth2Tokens,
  sync: ProviderProfileSync,
  reloadStored?: () => Promise<OAuth2Tokens | null>
): Promise<ProviderProfile | null> {
  const refresh = async (base: OAuth2Tokens): Promise<OAuth2Tokens | null> => {
    if (!base.refreshToken) return null;
    const refreshed = await sync.refreshTokens(base.refreshToken).catch(() => null);
    if (!refreshed?.accessToken) return null;
    await persistRefreshedTokens(ctx, accountId, refreshed);
    return {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? base.refreshToken,
      idToken: refreshed.idToken ?? base.idToken,
      accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
    };
  };
  const attempt = async (
    tokens: OAuth2Tokens
  ): Promise<{ profile: ProviderProfile | null; error: unknown }> => {
    try {
      return { profile: await sync.fetchProfile(tokens), error: null };
    } catch (error) {
      return { profile: null, error };
    }
  };

  let tokens = stored;
  let refreshed = false;
  const startedLive = hasLiveAccessToken(stored);
  if (!startedLive) {
    const fresh = await refresh(stored);
    if (fresh) {
      tokens = fresh;
      refreshed = true;
    }
  }

  let result = await attempt(tokens);

  if (!result.profile && !refreshed && startedLive) {
    const fresh = await refresh(tokens);
    if (fresh) {
      result = await attempt(fresh);
      refreshed = true;
    }
  }

  if (!result.profile && !refreshed && reloadStored) {
    // The winning sync may not have stored its fresh tokens yet when
    // this sync first re-reads the account, so re-read a few times.
    let reloaded: OAuth2Tokens | null = null;
    for (let i = 0; i < 3; i++) {
      reloaded = await reloadStored().catch(() => null);
      if (reloaded && (reloaded.accessToken !== stored.accessToken || reloaded.refreshToken !== stored.refreshToken)) break;
      reloaded = null;
      if (i < 2) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (reloaded) {
      let retryTokens = reloaded;
      if (!hasLiveAccessToken(reloaded)) {
        retryTokens = (await refresh(reloaded)) ?? reloaded;
      }
      const retry = await attempt(retryTokens);
      if (retry.profile || !result.error) result = retry;
    }
  }

  if (result.error) throw result.error;
  return result.profile;
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
  return syncProviderProfile(ctx, account.id, stored, createSync(provider), async () => {
    const again = (await ctx.internalAdapter.findAccounts(uid)).find((entry) => entry.id === account.id);
    return again ? decryptStoredTokens(ctx, again) : null;
  });
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

  if (providerId === 'minecraft' && options?.minecraftAuthEnabled === false) {
    return { name: null, email: null, avatarUrl: null };
  }

  const stored = await decryptStoredTokens(ctx, account);
  if (!stored) return null;

  const sync = providerId === 'xbox' ? xboxProfileSync(options) : minecraftProfileSync(options);

  // The Xbox account row exists at this point, so the provider is
  // linked; a profile that cannot be resolved (for example an account
  // that owns no Minecraft) yields an empty profile, not null.
  try {
    const profile = await syncProviderProfile(ctx, account.id, stored, sync, async () => {
      const again = (await ctx.internalAdapter.findAccounts(uid)).find((entry) => entry.id === account.id);
      return again ? decryptStoredTokens(ctx, again) : null;
    });
    if (profile) return profile;
  } catch (error) {
    console.error(`Failed to resolve the ${providerId} profile:`, error instanceof Error ? error.message : error);
  }
  return { name: null, email: null, avatarUrl: null };
}
