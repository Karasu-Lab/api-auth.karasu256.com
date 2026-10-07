import { decryptOAuthToken } from 'better-auth/oauth2';
import type { AuthContext } from '@better-auth/core';
import type { Auth } from './auth';

export interface ProviderProfile {
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

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
export async function getProviderProfile(auth: Auth, uid: string, providerId: string): Promise<ProviderProfile | null> {
  const ctx = (await auth.$context) as unknown as AuthContext;
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

  if (!info && refreshToken && provider.refreshAccessToken) {
    const refreshed = await provider.refreshAccessToken(refreshToken).catch(() => null);
    if (refreshed?.accessToken) {
      info = await provider.getUserInfo({ ...refreshed }).catch(() => null);
    }
  }

  if (!info) return null;
  return { name: info.user.name ?? null, email: info.user.email ?? null, avatarUrl: info.user.image ?? null };
}
