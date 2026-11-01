const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const XBOX_LIVE_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_AUTH_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const XBOX_PROFILE_URL = 'https://profile.xboxlive.com/users/xuid';
export const XBOX_RELYING_PARTY = 'http://auth.xboxlive.com';
export const MINECRAFT_RELYING_PARTY = 'rp://api.minecraftservices.com/';

export interface XboxToken {
  token: string;
  userHash: string;
  xuid: string | null;
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

export async function authenticateXboxLive(microsoftAccessToken: string): Promise<XboxToken | null> {
  const body = await postJson<XboxTokenResponse>(XBOX_LIVE_AUTH_URL, {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${microsoftAccessToken}` },
    RelyingParty: XBOX_RELYING_PARTY,
    TokenType: 'JWT',
  });
  return body ? toXboxToken(body) : null;
}

export async function authorizeXsts(xboxLiveToken: string, relyingParty: string): Promise<XboxToken | null> {
  const body = await postJson<XboxTokenResponse>(XSTS_AUTH_URL, {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xboxLiveToken] },
    RelyingParty: relyingParty,
    TokenType: 'JWT',
  });
  return body ? toXboxToken(body) : null;
}

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

export interface MicrosoftTokenCandidates {
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
}

export async function microsoftTokenAttempts(candidates: MicrosoftTokenCandidates): Promise<string[]> {
  const attempts: string[] = [];
  if (candidates.accessToken) attempts.push(candidates.accessToken);
  if (candidates.refreshToken && candidates.clientId && candidates.clientSecret) {
    const exchanged = await exchangeMicrosoftRefreshToken(candidates.refreshToken, candidates.clientId, candidates.clientSecret);
    if (exchanged && exchanged !== candidates.accessToken) attempts.push(exchanged);
  }
  return attempts;
}

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
