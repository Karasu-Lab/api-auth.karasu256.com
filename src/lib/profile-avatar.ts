import { avatarUserSchema, deviceSessionAvatarEntrySchema, userinfoAvatarClaimsSchema } from '@karasu-lab/types/server';

const PROFILE_PATHS = new Set(['/api/auth/get-session', '/api/auth/multi-session/list-device-sessions', '/api/auth/oauth2/userinfo']);

export function cdnProfileAvatarUrl(env: Env, userId: string, image: string | null | undefined): string | null {
  if (!image) return null;
  let version: string | null = null;
  try {
    version = new URL(image).searchParams.get('v');
  } catch {
    version = null;
  }
  const base = `${env.CDN_URL}/u/profiles/${userId}/avatars/default/avatar.png`;
  return version ? `${base}?v=${version}` : base;
}

function rewriteUserImage(env: Env, user: unknown): boolean {
  const parsed = avatarUserSchema.safeParse(user);
  if (!parsed.success) return false;
  const rewritten = cdnProfileAvatarUrl(env, parsed.data.id, parsed.data.image);
  if (!rewritten || rewritten === parsed.data.image) return false;
  (user as { image: string }).image = rewritten;
  return true;
}

export async function withCdnProfileAvatarUrls(env: Env, pathname: string, response: Response): Promise<Response> {
  if (!PROFILE_PATHS.has(pathname) || !response.ok) return response;

  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }

  let changed = false;
  if (pathname === '/api/auth/multi-session/list-device-sessions' && Array.isArray(body)) {
    for (const entry of body) {
      const parsed = deviceSessionAvatarEntrySchema.safeParse(entry);
      if (parsed.success && rewriteUserImage(env, (entry as { user?: unknown }).user)) changed = true;
    }
  } else if (pathname === '/api/auth/oauth2/userinfo') {
    const parsed = userinfoAvatarClaimsSchema.safeParse(body);
    if (parsed.success) {
      const rewritten = cdnProfileAvatarUrl(env, parsed.data.sub, parsed.data.picture);
      if (rewritten && rewritten !== parsed.data.picture) {
        (body as { picture: string }).picture = rewritten;
        changed = true;
      }
    }
  } else if (deviceSessionAvatarEntrySchema.safeParse(body).success) {
    changed = rewriteUserImage(env, (body as { user?: unknown }).user);
  }

  if (!changed) return response;

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers });
}
