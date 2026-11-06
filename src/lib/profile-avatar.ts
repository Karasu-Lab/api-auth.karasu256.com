const PROFILE_PATHS = new Set(['/api/auth/get-session', '/api/auth/multi-session/list-device-sessions', '/api/auth/oauth2/userinfo']);

export function cdnProfileAvatarUrl(env: Env, userId: string, image: string | null | undefined): string | null {
  if (!image) return null;
  let version: string | null = null;
  try {
    version = new URL(image).searchParams.get('v');
  } catch {
    version = null;
  }
  const base = `${env.CDN_URL}/u/profiles/${userId}/avatar.png`;
  return version ? `${base}?v=${version}` : base;
}

function rewriteUserImage(env: Env, user: unknown): boolean {
  if (typeof user !== 'object' || user === null) return false;
  const record = user as { id?: unknown; image?: unknown };
  if (typeof record.id !== 'string' || typeof record.image !== 'string') return false;
  const rewritten = cdnProfileAvatarUrl(env, record.id, record.image);
  if (!rewritten || rewritten === record.image) return false;
  record.image = rewritten;
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
      if (typeof entry === 'object' && entry !== null && rewriteUserImage(env, (entry as { user?: unknown }).user)) changed = true;
    }
  } else if (pathname === '/api/auth/oauth2/userinfo') {
    if (typeof body === 'object' && body !== null) {
      const claims = body as { sub?: unknown; picture?: unknown };
      if (typeof claims.sub === 'string' && typeof claims.picture === 'string') {
        const rewritten = cdnProfileAvatarUrl(env, claims.sub, claims.picture);
        if (rewritten && rewritten !== claims.picture) {
          claims.picture = rewritten;
          changed = true;
        }
      }
    }
  } else if (typeof body === 'object' && body !== null) {
    changed = rewriteUserImage(env, (body as { user?: unknown }).user);
  }

  if (!changed) return response;

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers });
}
