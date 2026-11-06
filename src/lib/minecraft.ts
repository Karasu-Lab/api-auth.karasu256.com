import type { MinecraftProfile, XboxToken } from '@karasu-lab/types/server';

export type { MinecraftProfile };

const MINECRAFT_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MINECRAFT_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';
const MINECRAFT_USER_AGENT = 'MinecraftLauncher/2.2.10675';

async function readMinecraftResponse(res: Response | null, stage: string): Promise<string> {
  const text = res ? await res.text().catch(() => '') : '';
  if (!res?.ok) throw new Error(`${stage} failed: HTTP ${res?.status ?? 'no response'}: ${text.slice(0, 300)}`);
  return text;
}

export async function loginToMinecraft(xsts: XboxToken): Promise<string> {
  const res = await fetch(MINECRAFT_LOGIN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': MINECRAFT_USER_AGENT },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${xsts.userHash};${xsts.token}` }),
  }).catch(() => null);
  const text = await readMinecraftResponse(res, 'Minecraft login');
  const body = JSON.parse(text) as { access_token?: string };
  if (!body.access_token) throw new Error(`Minecraft login failed: the response did not include an access token: ${text.slice(0, 300)}`);
  return body.access_token;
}

export async function getMinecraftProfile(minecraftAccessToken: string): Promise<MinecraftProfile> {
  const res = await fetch(MINECRAFT_PROFILE_URL, {
    headers: { authorization: `Bearer ${minecraftAccessToken}`, accept: 'application/json', 'user-agent': MINECRAFT_USER_AGENT },
  }).catch(() => null);
  const text = await readMinecraftResponse(res, 'Minecraft profile');
  const body = JSON.parse(text) as {
    id?: string;
    name?: string;
    skins?: Array<{ state?: string; url?: string }>;
  };
  if (!body.id || !body.name) throw new Error(`Minecraft profile failed: the response did not include a profile: ${text.slice(0, 300)}`);
  const activeSkin = body.skins?.find((skin) => skin.state === 'ACTIVE') ?? body.skins?.[0];
  return { id: body.id, name: body.name, skinTextureUrl: activeSkin?.url ?? null };
}
