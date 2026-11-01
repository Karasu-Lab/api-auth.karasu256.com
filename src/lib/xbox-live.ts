import type { OAuth2Tokens } from '@better-auth/core/oauth2';

const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const XBOX_LIVE_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_AUTH_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const XBOX_PROFILE_URL = 'https://profile.xboxlive.com/users/xuid';
const XBOX_AUTH_RELYING_PARTY = 'http://auth.xboxlive.com';
export const XBOX_RELYING_PARTY = 'http://xboxlive.com';
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

const XBOX_ERROR_MESSAGES: Record<number, string> = {
  2148916227: 'The account was banned by Xbox for violating one or more Community Standards for Xbox.',
  2148916229: 'The account is restricted and a guardian has not given permission to play online.',
  2148916233: 'The account does not have an Xbox profile. Create one at https://www.xbox.com first.',
  2148916234: "The account has not accepted Xbox's Terms of Use.",
  2148916235: 'The account resides in a region that Xbox Live does not support.',
  2148916236: 'The account requires proof of age.',
  2148916237: 'The account has reached its limit for playtime.',
  2148916238: 'The account is under 18 and must be added to a Microsoft family by an adult first.',
};

// Xbox Live failures carry an XErr code; keep it (and its known
// explanation) in the message instead of collapsing the failure.
export class XboxLiveError extends Error {
  readonly status: number | null;
  readonly xErr: number | null;

  constructor(stage: string, status: number | null, xErr: number | null, detail: string | null) {
    super([`${stage} failed`, status != null ? `HTTP ${status}` : null, xErr != null ? `XErr ${xErr}` : null, (xErr != null ? XBOX_ERROR_MESSAGES[xErr] : undefined) ?? detail].filter(Boolean).join(': '));
    this.name = 'XboxLiveError';
    this.status = status;
    this.xErr = xErr;
  }
}

async function postXbox(url: string, body: unknown, stage: string): Promise<XboxTokenResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);
  const text = res ? await res.text().catch(() => '') : '';
  if (!res?.ok) {
    let xErr: number | null = null;
    let detail: string | null = text || null;
    try {
      const parsed = JSON.parse(text) as { XErr?: number | string; Message?: string };
      const parsedXErr = typeof parsed.XErr === 'string' ? Number.parseInt(parsed.XErr, 10) : parsed.XErr;
      if (typeof parsedXErr === 'number' && Number.isInteger(parsedXErr)) xErr = parsedXErr;
      if (parsed.Message) detail = parsed.Message;
    } catch {}
    if (xErr == null) {
      const headerXErr = Number.parseInt(res?.headers.get('x-err') ?? '', 10);
      if (Number.isInteger(headerXErr)) xErr = headerXErr;
    }
    throw new XboxLiveError(stage, res?.status ?? null, xErr, detail);
  }
  return JSON.parse(text) as XboxTokenResponse;
}

export async function authenticateXboxLive(microsoftAccessToken: string): Promise<XboxToken> {
  const body = await postXbox(
    XBOX_LIVE_AUTH_URL,
    {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${microsoftAccessToken}` },
      RelyingParty: XBOX_AUTH_RELYING_PARTY,
      TokenType: 'JWT',
    },
    'Xbox Live authentication'
  );
  const token = toXboxToken(body);
  if (!token) throw new XboxLiveError('Xbox Live authentication', 200, null, 'The response did not include a token.');
  return token;
}

export async function authorizeXsts(xboxLiveToken: string, relyingParty: string): Promise<XboxToken> {
  const body = await postXbox(
    XSTS_AUTH_URL,
    {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xboxLiveToken] },
      RelyingParty: relyingParty,
      TokenType: 'JWT',
    },
    'XSTS authorization'
  );
  const token = toXboxToken(body);
  if (!token) throw new XboxLiveError('XSTS authorization', 200, null, 'The response did not include a token.');
  return token;
}

// Exchanges a Microsoft refresh token for a fresh Xbox-scoped token
// set, including the rotated refresh token the caller must sync back.
export async function refreshMicrosoftTokens(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<OAuth2Tokens | null> {
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
  if (!res?.ok) {
    const detail = res ? await res.text().catch(() => '') : '';
    console.error(
      `Failed to refresh the Microsoft tokens: HTTP ${res?.status ?? 'no response'}${detail ? `: ${detail}` : ''}`
    );
    return null;
  }
  const body = (await res.json().catch(() => null)) as { access_token?: string; refresh_token?: string; expires_in?: number } | null;
  if (!body?.access_token) return null;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    accessTokenExpiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : undefined,
  };
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
