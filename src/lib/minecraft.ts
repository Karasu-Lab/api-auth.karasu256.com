import {
  authorizeXsts,
  authenticateXboxLive,
  microsoftTokenAttempts,
  MINECRAFT_RELYING_PARTY,
  type MicrosoftTokenCandidates,
  type XboxToken,
} from './xbox-live';

/**
 * Minecraft Services on top of the Xbox Live chain (see
 * `lib/xbox-live.ts`): an XSTS token for the Minecraft relying party is
 * exchanged for a Minecraft access token, which reads the player's
 * Minecraft profile. A Microsoft account that does not own Minecraft
 * gets no profile here, which is exactly how the provider profile API
 * distinguishes a linked Minecraft account from an unlinked one.
 */

const MINECRAFT_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MINECRAFT_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

export interface MinecraftProfile {
  /** The player's Minecraft UUID, without dashes, as Minecraft Services reports it. */
  id: string;
  /** The player's in-game name. */
  name: string;
  /**
   * The active skin's texture URL on Mojang's texture host, when the
   * profile has one. This is a public URL, but the image behind it is
   * the raw UV-mapped skin texture, not a ready-made avatar: clients
   * that display it as an avatar must crop and composite the head
   * region themselves (client-side conversion).
   */
  skinTextureUrl: string | null;
}

/** Exchanges an XSTS token for the Minecraft relying party for a Minecraft access token. */
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

/** Reads the Minecraft profile for a Minecraft access token. */
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

/**
 * Runs the whole chain from a linked Microsoft account's stored tokens
 * to the Minecraft profile, trying each Microsoft token candidate in
 * the shared order (see `microsoftTokenAttempts`); the Minecraft login
 * needs the intermediate XSTS token, so the chain is spelled out here.
 */
export async function getMinecraftProfileFromMicrosoftTokens(
  candidates: MicrosoftTokenCandidates
): Promise<MinecraftProfile | null> {
  for (const microsoftToken of await microsoftTokenAttempts(candidates)) {
    const xboxLive = await authenticateXboxLive(microsoftToken);
    if (!xboxLive) continue;
    const xsts = await authorizeXsts(xboxLive.token, MINECRAFT_RELYING_PARTY);
    if (!xsts) continue;
    const minecraftToken = await loginToMinecraft(xsts);
    if (!minecraftToken) continue;
    const profile = await getMinecraftProfile(minecraftToken);
    if (profile) return profile;
  }
  return null;
}
