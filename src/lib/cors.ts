import { getAuthConfig } from '../config';

/**
 * better-auth only uses `trustedOrigins` for its own cookie/CSRF origin
 * checks and never emits `Access-Control-*` headers, so cross-origin calls
 * from the other apps' `authClient` are blocked by the browser without them.
 * The allowlist is the same `trustedOrigins` table better-auth reads, so the
 * two cannot drift apart.
 */
function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  if (!origin || !getAuthConfig(env).trustedOrigins.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  };
}

/** Answers a CORS preflight request, or returns `null` when the request is not one. */
export function handlePreflight(env: Env, request: Request): Response | null {
  if (request.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: corsHeaders(env, request.headers.get('origin')) });
}

/** Returns a copy of `response` carrying CORS headers for a trusted cross-origin caller. */
export function withCors(env: Env, request: Request, response: Response): Response {
  const headers = corsHeaders(env, request.headers.get('origin'));
  if (Object.keys(headers).length === 0) return response;
  const copy = new Response(response.body, response);
  for (const [key, value] of Object.entries(headers)) copy.headers.set(key, value);
  return copy;
}
