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
import { storeProviderAvatar } from './avatar-api';
import {
  AccountLinkCreateRepository,
  AccountLinkGetRepository,
  AccountLinkUpdateRepository,
  type AccountLink,
} from './redis/account-link-repositories';
import type { ProviderProfile } from '@karasu-lab/types/shared';

export type { ProviderProfile };

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
    console.error('Failed to sync the refreshed provider tokens:', error);
  });
}

type SharedRefreshes = Map<string, Promise<OAuth2Tokens | null>>;

async function syncProviderProfile(
  ctx: AuthContext,
  accountId: string,
  stored: OAuth2Tokens,
  sync: ProviderProfileSync,
  sharedRefreshes: SharedRefreshes
): Promise<ProviderProfile | null> {
  let tokens = stored;
  if (!hasLiveAccessToken(stored) && stored.refreshToken) {
    const refreshToken = stored.refreshToken;
    let pending = sharedRefreshes.get(accountId);
    if (!pending) {
      pending = (async () => {
        const refreshed = await sync.refreshTokens(refreshToken).catch(() => null);
        if (!refreshed?.accessToken) return null;
        await persistRefreshedTokens(ctx, accountId, refreshed);
        return {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? refreshToken,
          idToken: refreshed.idToken ?? stored.idToken,
          accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
        };
      })();
      sharedRefreshes.set(accountId, pending);
    }
    tokens = (await pending) ?? stored;
  }
  return sync.fetchProfile(tokens);
}

const PROFILE_CACHE_ORIGIN = 'https://provider-profile.cache.invalid';
const PROFILE_CACHE_TTL_SECONDS = 300;

function profileCacheRequest(accountId: string, providerId: string): Request {
  return new Request(`${PROFILE_CACHE_ORIGIN}/${encodeURIComponent(accountId)}/${encodeURIComponent(providerId)}`);
}

async function readCachedProfile(accountId: string, providerId: string): Promise<ProviderProfile | null> {
  if (typeof caches === 'undefined') return null;
  const hit = await caches.default.match(profileCacheRequest(accountId, providerId)).catch(() => null);
  return hit ? ((await hit.json().catch(() => null)) as ProviderProfile | null) : null;
}

async function writeCachedProfile(accountId: string, providerId: string, profile: ProviderProfile): Promise<void> {
  if (typeof caches === 'undefined') return;
  await caches.default
    .put(
      profileCacheRequest(accountId, providerId),
      Response.json(profile, { headers: { 'cache-control': `private, max-age=${PROFILE_CACHE_TTL_SECONDS}` } })
    )
    .catch(() => undefined);
}

function hasProfileData(profile: ProviderProfile): boolean {
  return Boolean(profile.name || profile.email || profile.avatarUrl);
}

async function withProfileCache(
  accountId: string,
  providerId: string,
  resolve: () => Promise<ProviderProfile | null>
): Promise<ProviderProfile | null> {
  const cached = await readCachedProfile(accountId, providerId);
  if (cached) return cached;
  const profile = await resolve();
  if (profile && hasProfileData(profile)) await writeCachedProfile(accountId, providerId, profile);
  return profile;
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

async function resolveSocialProfile(
  ctx: AuthContext,
  account: StoredAccount & { providerId: string },
  providerId: string,
  sharedRefreshes: SharedRefreshes
): Promise<ProviderProfile | null> {
  const provider = ctx.socialProviders.find((entry) => entry.id === providerId);
  if (!provider) return null;

  const stored = await decryptStoredTokens(ctx, account);
  if (!stored) return null;

  const createSync = SOCIAL_PROFILE_SYNC_FACTORIES[providerId] ?? socialProfileSync;
  return syncProviderProfile(ctx, account.id, stored, createSync(provider), sharedRefreshes);
}

async function resolveProfileFromAccounts(
  env: Env,
  ctx: AuthContext,
  uid: string,
  accounts: (StoredAccount & { providerId: string })[],
  providerId: string,
  sharedRefreshes: SharedRefreshes,
  options?: ProviderProfileOptions
): Promise<ProviderProfile | null> {
  const account = accounts.find((entry) => entry.providerId === accountProviderId(providerId));
  if (!account) return null;

  return withProfileCache(account.id, providerId, async () => {
    const profile = isDerivedProvider(providerId)
      ? await resolveDerivedProfile(ctx, account, providerId, sharedRefreshes, options)
      : await resolveSocialProfile(ctx, account, providerId, sharedRefreshes);
    if (!profile?.avatarUrl) return profile;
    return { ...profile, avatarUrl: await storeProviderAvatar(env, uid, providerId, profile.avatarUrl) };
  });
}

function isDerivedProvider(providerId: string): boolean {
  return (DERIVED_PROVIDER_IDS as readonly string[]).includes(providerId);
}

function accountProviderId(providerId: string): string {
  return isDerivedProvider(providerId) ? XBOX_PROVIDER_ID : providerId;
}

async function loadAccountLinks(env: Env, ctx: AuthContext, uid: string): Promise<AccountLink[]> {
  const cached = await new AccountLinkGetRepository(env).get(uid);
  if (cached) return cached;
  const accounts = await ctx.internalAdapter.findAccounts(uid);
  const providerIds = [...ctx.socialProviders.map((provider) => provider.id), ...DERIVED_PROVIDER_IDS];
  const links = providerIds.map((providerId) => {
    const account = accounts.find((entry) => entry.providerId === accountProviderId(providerId));
    return { providerId, id: account?.id ?? null, url: null, linked: Boolean(account) };
  });
  await new AccountLinkCreateRepository(env).create(uid, links);
  return links;
}

async function recordAccountLinkUrls(env: Env, uid: string, links: AccountLink[], profiles: Map<string, ProviderProfile | null>) {
  const updated = links.map((link) => (profiles.has(link.providerId) ? { ...link, url: profiles.get(link.providerId)?.avatarUrl ?? null } : link));
  if (updated.some((link, index) => link.url !== links[index].url)) await new AccountLinkUpdateRepository(env).update(uid, updated);
}

export async function getProviderProfile(
  env: Env,
  auth: Auth,
  uid: string,
  providerId: string,
  options?: ProviderProfileOptions
): Promise<ProviderProfile | null> {
  const ctx = (await auth.$context) as unknown as AuthContext;
  const links = await loadAccountLinks(env, ctx, uid);
  const link = links.find((entry) => entry.providerId === providerId);
  if (link && !link.linked) return null;
  const accounts = await ctx.internalAdapter.findAccounts(uid);
  const profile = await resolveProfileFromAccounts(env, ctx, uid, accounts, providerId, new Map(), options);
  if (link) await recordAccountLinkUrls(env, uid, links, new Map([[providerId, profile]]));
  return profile;
}

export async function streamProviderProfiles(
  env: Env,
  auth: Auth,
  uid: string,
  onProfile: (providerId: string, profile: ProviderProfile | null) => void,
  options?: ProviderProfileOptions
): Promise<void> {
  const ctx = (await auth.$context) as unknown as AuthContext;
  const links = await loadAccountLinks(env, ctx, uid);
  const accounts = links.some((link) => link.linked) ? await ctx.internalAdapter.findAccounts(uid) : [];
  const sharedRefreshes: SharedRefreshes = new Map();
  const profiles = new Map<string, ProviderProfile | null>();
  await Promise.all(
    links.map(async ({ providerId, linked }) => {
      if (!linked || (providerId === 'minecraft' && !options?.minecraftAuthEnabled)) return onProfile(providerId, null);
      try {
        const profile = await resolveProfileFromAccounts(env, ctx, uid, accounts, providerId, sharedRefreshes, options);
        profiles.set(providerId, profile);
        onProfile(providerId, profile);
      } catch {
        onProfile(providerId, null);
      }
    })
  );
  await recordAccountLinkUrls(env, uid, links, profiles);
}

export async function getProviderAccessToken(auth: Auth, uid: string, providerId: string): Promise<string | null> {
  const ctx = (await auth.$context) as unknown as AuthContext;

  const account = (await ctx.internalAdapter.findAccounts(uid)).find((entry) => entry.providerId === providerId);
  if (!account) return null;

  const provider = ctx.socialProviders.find((entry) => entry.id === providerId);
  if (!provider) return null;

  const stored = await decryptStoredTokens(ctx, account);
  if (!stored?.accessToken) return null;
  if (hasLiveAccessToken(stored) || !stored.refreshToken || !provider.refreshAccessToken) return stored.accessToken;

  const refreshed = await provider.refreshAccessToken(stored.refreshToken).catch(() => null);
  if (!refreshed?.accessToken) return stored.accessToken;
  await persistRefreshedTokens(ctx, account.id, refreshed);
  return refreshed.accessToken;
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

async function resolveDerivedProfile(
  ctx: AuthContext,
  account: StoredAccount & { providerId: string },
  providerId: string,
  sharedRefreshes: SharedRefreshes,
  options?: ProviderProfileOptions
): Promise<ProviderProfile | null> {
  if (providerId === 'minecraft' && options?.minecraftAuthEnabled === false) {
    return { name: null, email: null, avatarUrl: null };
  }

  const stored = await decryptStoredTokens(ctx, account);
  if (!stored) return null;

  const sync = providerId === 'xbox' ? xboxProfileSync(options) : minecraftProfileSync(options);

  try {
    const profile = await syncProviderProfile(ctx, account.id, stored, sync, sharedRefreshes);
    if (profile) return profile;
  } catch (error) {
    console.error(`Failed to resolve the ${providerId} profile:`, error);
  }
  return { name: null, email: null, avatarUrl: null };
}
