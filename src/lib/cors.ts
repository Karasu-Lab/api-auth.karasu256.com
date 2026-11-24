import { withAuth } from './request-auth';

/**
 * better-auth only uses `trustedOrigins` for its own cookie/CSRF origin
 * checks and never emits `Access-Control-*` headers, so cross-origin calls
 * from the other apps' `authClient` are blocked by the browser without them.
 * The origin is checked with better-auth's own `isTrustedOrigin`, so the two
 * cannot drift apart.
 */
async function corsHeaders(env: Env, request: Request): Promise<Record<string, string>> {
  const origin = request.headers.get('origin');
  if (!origin || !(await withAuth(env, async (auth) => (await auth.$context).isTrustedOrigin(origin)))) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, cf-turnstile-response',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** Answers a CORS preflight request, or returns `null` when the request is not one. */
export async function handlePreflight(env: Env, request: Request): Promise<Response | null> {
  if (request.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: await corsHeaders(env, request) });
}

/** Returns a copy of `response` carrying CORS headers for a trusted cross-origin caller. */
export async function withCors(env: Env, request: Request, response: Response): Promise<Response> {
  const headers = await corsHeaders(env, request);
  if (Object.keys(headers).length === 0) return response;
  const copy = new Response(response.body, response);
  for (const [key, value] of Object.entries(headers)) copy.headers.set(key, value);
  return copy;
}
