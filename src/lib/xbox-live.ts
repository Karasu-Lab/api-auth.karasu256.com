/**
 * The Xbox Live authentication chain that a Microsoft access token feeds
 * into, plus the Minecraft login built on top of it.
 *
 * A linked Microsoft account is the only credential this chain starts
 * from, and its better-auth access token cannot be used directly: that
 * token's audience is Microsoft Graph, while Xbox Live only accepts a
 * token scoped `XboxLive.signin`. The stored refresh token (granted
 * because the Microsoft provider requests `offline_access`) is therefore
 * exchanged for an Xbox-scoped token first; the stored access token is
 * still tried first in case it already carries the scope.
 *
 * Chain: Microsoft token → Xbox Live user token
 * (`user.auth.xboxlive.com`) → XSTS token (`xsts.auth.xboxlive.com`,
 * issued per relying party) → the relying party's own API. The Xbox
 * profile uses the `http://auth.xboxlive.com` relying party; Minecraft
 * uses `rp://api.minecraftservices.com/` and one more exchange at
 * `api.minecraftservices.com/authentication/login_with_xbox`.
 */

const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const XBOX_LIVE_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_AUTH_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const XBOX_PROFILE_URL = 'https://profile.xboxlive.com/users/xuid';
export const XBOX_RELYING_PARTY = 'http://auth.xboxlive.com';
export const MINECRAFT_RELYING_PARTY = 'rp://api.minecraftservices.com/';

export interface XboxToken {
  token: string;
  /** The user hash (`uhs`) that accompanies the token in `XBL3.0` authorization headers and identity tokens. */
  userHash: string;
  /** The Xbox user ID (XUID) from the token's display claims, when the relying party exposes it. */
  xuid: string | null;
  /** The gamertag from the token's display claims, when the relying party exposes it. */
  gamertag: string | null;
}

interface XboxTokenResponse {
  Token?: string;
  DisplayClaims?: { xui?: Array<Record<string, string>> };
}

function toXboxToken(body: XboxTokenResponse): XboxToken | null {
  const claims = body.DisplayClaims?.xui?.[0];
  if (!body.Token || !claims?.uhs) return null;
  return { token: body.Token, userHash: claims.uhs, xuid: claims.xid ?? null, gamertag: claims.gt ?? null };
}

async function postJson<T>(url: string, body: unknown): Promise<T | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json().catch(() => null)) as T | null;
}

/** Authenticates a Microsoft access token with Xbox Live, returning the Xbox Live user token. */
export async function authenticateXboxLive(microsoftAccessToken: string): Promise<XboxToken | null> {
  const body = await postJson<XboxTokenResponse>(XBOX_LIVE_AUTH_URL, {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${microsoftAccessToken}` },
    RelyingParty: XBOX_RELYING_PARTY,
    TokenType: 'JWT',
  });
  return body ? toXboxToken(body) : null;
}

/** Upgrades an Xbox Live user token to an XSTS token for one relying party. */
export async function authorizeXsts(xboxLiveToken: string, relyingParty: string): Promise<XboxToken | null> {
  const body = await postJson<XboxTokenResponse>(XSTS_AUTH_URL, {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xboxLiveToken] },
    RelyingParty: relyingParty,
    TokenType: 'JWT',
  });
  return body ? toXboxToken(body) : null;
}

/**
 * Exchanges a stored Microsoft refresh token for an access token scoped
 * `XboxLive.signin`, the only form Xbox Live accepts. The client secret
 * is included because the app registration is a confidential (web)
 * client; the exchange runs entirely on this worker.
 */
export async function exchangeMicrosoftRefreshToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<string | null> {
  const res = await fetch(MICROSOFT_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'XboxLive.signin offline_access',
    }),
  }).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => null)) as { access_token?: string } | null;
  return body?.access_token ?? null;
}

/** The stored Microsoft tokens a chain attempt can start from. */
export interface MicrosoftTokenCandidates {
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Lists the Microsoft access tokens a chain attempt tries, in order:
 * the stored access token, then a fresh Xbox-scoped token exchanged
 * from the refresh token.
 */
export async function microsoftTokenAttempts(candidates: MicrosoftTokenCandidates): Promise<string[]> {
  const attempts: string[] = [];
  if (candidates.accessToken) attempts.push(candidates.accessToken);
  if (candidates.refreshToken && candidates.clientId && candidates.clientSecret) {
    const exchanged = await exchangeMicrosoftRefreshToken(candidates.refreshToken, candidates.clientId, candidates.clientSecret);
    if (exchanged && exchanged !== candidates.accessToken) attempts.push(exchanged);
  }
  return attempts;
}

/**
 * Runs the first half of the chain for one relying party.
 *
 * @returns The XSTS token for the relying party, or `null` when no
 * candidate completes the chain (no Xbox profile, a child account that
 * is not in a family, an account from a region without Xbox Live, a
 * token without the Xbox scope and no usable refresh token, ...).
 */
export async function getXstsToken(relyingParty: string, candidates: MicrosoftTokenCandidates): Promise<XboxToken | null> {
  for (const microsoftToken of await microsoftTokenAttempts(candidates)) {
    const xboxLive = await authenticateXboxLive(microsoftToken);
    if (!xboxLive) continue;
    const xsts = await authorizeXsts(xboxLive.token, relyingParty);
    if (xsts) return xsts;
  }
  return null;
}

export interface XboxProfile {
  gamertag: string | null;
  avatarUrl: string | null;
}

/**
 * Reads the signed-in user's public Xbox profile (gamertag and display
 * picture) with an XSTS token for the Xbox relying party. The display
 * picture URL is hosted by Xbox's own CDN and is publicly readable,
 * which is what the linking screen renders as the provider avatar.
 */
export async function getXboxProfile(xsts: XboxToken): Promise<XboxProfile | null> {
  if (!xsts.xuid) return xsts.gamertag ? { gamertag: xsts.gamertag, avatarUrl: null } : null;
  const settings = 'Gamertag,GameDisplayPicRaw';
  const res = await fetch(`${XBOX_PROFILE_URL}(${encodeURIComponent(xsts.xuid)})/profile/settings?settings=${settings}`, {
    headers: {
      authorization: `XBL3.0 x=${xsts.userHash};${xsts.token}`,
      'x-xbl-contract-version': '2',
      accept: 'application/json',
    },
  }).catch(() => null);
  if (!res?.ok) return xsts.gamertag ? { gamertag: xsts.gamertag, avatarUrl: null } : null;

  const body = (await res.json().catch(() => null)) as {
    profileUsers?: Array<{ settings?: Array<{ id?: string; value?: string | null }> }>;
  } | null;
  const values = new Map((body?.profileUsers?.[0]?.settings ?? []).map((setting) => [setting.id, setting.value ?? null]));
  return { gamertag: values.get('Gamertag') ?? xsts.gamertag, avatarUrl: values.get('GameDisplayPicRaw') ?? null };
}
