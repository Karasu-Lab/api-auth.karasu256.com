import { decryptOAuthToken } from 'better-auth/oauth2';
import type { AuthContext } from '@better-auth/core';
import type { Auth } from './auth';
import { getMinecraftProfileFromMicrosoftTokens } from './minecraft';
import { getXboxProfile, getXstsToken, XBOX_RELYING_PARTY } from './xbox-live';

export interface ProviderProfile {
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

/** Options the derived Xbox / Minecraft profiles need beyond the auth instance itself. */
export interface ProviderProfileOptions {
  microsoftClientId?: string;
  microsoftClientSecret?: string;
}

/**
 * The providers the user endpoint resolves from a linked Microsoft
 * account instead of from an account row of their own. Linking
 * Microsoft is the only link action for both: Xbox Live is reached
 * through the Microsoft token chain (see `lib/xbox-live.ts`), and a
 * Minecraft profile exists exactly when that chain proves the account
 * owns Minecraft (see `lib/minecraft.ts`).
 */
export const DERIVED_PROVIDER_IDS = ['xbox', 'minecraft'] as const;

/**
 * Fetches a linked provider's current profile (name, email, avatar) by
 * replaying the account's stored OAuth tokens through better-auth's own
 * `getUserInfo` for that provider. better-auth's `account` table only
 * stores tokens, not a denormalized profile snapshot, so this is derived
 * fresh on every call.
 *
 * Falls back to `provider.refreshAccessToken` when the stored access token
 * has expired, since better-auth does not refresh it automatically outside
 * of an active sign-in/link flow.
 *
 * The cast to the generic `AuthContext` is safe: `decryptOAuthToken` only
 * reads `options` and `secretConfig`, which exist independent of the
 * instance's specific `Options` type.
 *
 * Decrypting can throw (better-auth's `isLikelyEncrypted` heuristic misjudges
 * some plaintext tokens, e.g. legacy 40-char hex GitHub tokens, as
 * ciphertext), which is treated like any other unresolvable profile.
 *
 * @returns `null` when the provider isn't linked or its profile can't be resolved.
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

  const tokens = (await ctx.internalAdapter.findAccounts(uid)).find((account) => account.providerId === providerId);
  if (!tokens) return null;

  const provider = ctx.socialProviders.find((p) => p.id === providerId);
  if (!provider) return null;

  let accessToken: string | undefined;
  let refreshToken: string | undefined;
  let idToken: string | undefined;
  try {
    accessToken = tokens.accessToken ? await decryptOAuthToken(tokens.accessToken, ctx) : undefined;
    refreshToken = tokens.refreshToken ? await decryptOAuthToken(tokens.refreshToken, ctx) : undefined;
    idToken = tokens.idToken ? await decryptOAuthToken(tokens.idToken, ctx) : undefined;
  } catch {
    return null;
  }

  let info = await provider.getUserInfo({ accessToken, refreshToken, idToken }).catch(() => null);
  let currentAccessToken = accessToken;

  if (!info && refreshToken && provider.refreshAccessToken) {
    const refreshed = await provider.refreshAccessToken(refreshToken).catch(() => null);
    if (refreshed?.accessToken) {
      currentAccessToken = refreshed.accessToken;
      info = await provider.getUserInfo({ ...refreshed }).catch(() => null);
    }
  }

  if (!info) return null;
  let avatarUrl = info.user.image ?? null;

  if (providerId === 'microsoft' && !avatarUrl && currentAccessToken) {
    avatarUrl = await getMicrosoftPhotoDataUrl(currentAccessToken);
  }

  return { name: info.user.name ?? null, email: info.user.email ?? null, avatarUrl };
}

/**
 * Reads the Microsoft profile photo from Microsoft Graph as a data
 * URL. The Microsoft provider itself runs with
 * `disableProfilePhoto: true` (see `lib/auth.ts`): better-auth would
 * embed this same data URL into the user info it applies to the user
 * record on sign-in and link, where it overflows the `users.image`
 * column. Fetching it here keeps the photo available to provider
 * profile consumers without it ever reaching a user update.
 *
 * @returns `null` when the account has no photo or it cannot be read.
 */
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

/**
 * Resolves the `xbox` and `minecraft` profiles from the user's linked
 * Microsoft account. Neither has an account row or OAuth flow of its
 * own: both are read through the Microsoft token chain, so a profile
 * comes back exactly when Microsoft is linked and the chain succeeds —
 * for Minecraft, only when the account owns the game.
 */
async function getDerivedProviderProfile(
  ctx: AuthContext,
  uid: string,
  providerId: string,
  options?: ProviderProfileOptions
): Promise<ProviderProfile | null> {
  const tokens = (await ctx.internalAdapter.findAccounts(uid)).find((account) => account.providerId === 'microsoft');
  if (!tokens) return null;

  let accessToken: string | undefined;
  let refreshToken: string | undefined;
  try {
    accessToken = tokens.accessToken ? await decryptOAuthToken(tokens.accessToken, ctx) : undefined;
    refreshToken = tokens.refreshToken ? await decryptOAuthToken(tokens.refreshToken, ctx) : undefined;
  } catch {
    return null;
  }

  const candidates = {
    accessToken,
    refreshToken,
    clientId: options?.microsoftClientId,
    clientSecret: options?.microsoftClientSecret,
  };

  if (providerId === 'xbox') {
    const xsts = await getXstsToken(XBOX_RELYING_PARTY, candidates);
    if (!xsts) return null;
    const profile = await getXboxProfile(xsts);
    if (!profile) return null;
    return { name: profile.gamertag, email: null, avatarUrl: profile.avatarUrl };
  }

  const profile = await getMinecraftProfileFromMicrosoftTokens(candidates);
  if (!profile) return null;
  return {
    name: profile.name,
    email: null,
    // Mojang's texture URL is public, so it can stand in for the
    // better-auth provider image as-is. What it points at is the raw
    // UV-mapped skin texture, though: clients convert it into an
    // avatar on their side (cropping and compositing the head region)
    // instead of rendering the URL directly as an image.
    avatarUrl: profile.skinTextureUrl,
  };
}
