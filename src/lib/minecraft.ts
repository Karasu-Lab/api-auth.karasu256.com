import {
  authorizeXsts,
  authenticateXboxLive,
  microsoftTokenAttempts,
  MINECRAFT_RELYING_PARTY,
  type MicrosoftTokenCandidates,
  type XboxToken,
} from './xbox-live';

const MINECRAFT_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MINECRAFT_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

export interface MinecraftProfile {
  id: string;
  name: string;
  // Mojang's raw UV-mapped skin texture URL; clients convert it into
  // an avatar themselves.
  skinTextureUrl: string | null;
}

export async function loginToMinecraft(xsts: XboxToken): Promise<string | null> {
  const res = await fetch(MINECRAFT_LOGIN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${xsts.userHash};${xsts.token}` }),
  }).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => null)) as { access_token?: string } | null;
  return body?.access_token ?? null;
}

export async function getMinecraftProfile(minecraftAccessToken: string): Promise<MinecraftProfile | null> {
  const res = await fetch(MINECRAFT_PROFILE_URL, {
    headers: { authorization: `Bearer ${minecraftAccessToken}`, accept: 'application/json' },
  }).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => null)) as {
    id?: string;
    name?: string;
    skins?: Array<{ state?: string; url?: string }>;
  } | null;
  if (!body?.id || !body.name) return null;
  const activeSkin = body.skins?.find((skin) => skin.state === 'ACTIVE') ?? body.skins?.[0];
  return { id: body.id, name: body.name, skinTextureUrl: activeSkin?.url ?? null };
}

// Throws the last chain failure when no token candidate completes it.
export async function getMinecraftProfileFromMicrosoftTokens(candidates: MicrosoftTokenCandidates): Promise<MinecraftProfile | null> {
  let lastError: unknown = null;
  for (const microsoftToken of await microsoftTokenAttempts(candidates)) {
    try {
      const xboxLive = await authenticateXboxLive(microsoftToken);
      const xsts = await authorizeXsts(xboxLive.token, MINECRAFT_RELYING_PARTY);
      const minecraftToken = await loginToMinecraft(xsts);
      if (!minecraftToken) continue;
      const profile = await getMinecraftProfile(minecraftToken);
      if (profile) return profile;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}
