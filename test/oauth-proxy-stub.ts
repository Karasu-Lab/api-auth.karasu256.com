/**
 * Black-box stub of the oauth.karasu256.com forwarder.
 *
 * The proxy host holds no OAuth processing of its own. It receives the
 * provider callback at `/api/auth/callback/<provider>`, verifies the
 * HMAC-signed state that api-auth issued, reads the origin to forward
 * to out of the signed payload, and redirects the browser to the same
 * path on that origin with the query string carried over untouched —
 * the signed state included. A state that is missing, malformed,
 * expired, or fails the signature check is rejected with 400.
 */
/**
 * Black-box stub of the production oauth.karasu256.com forwarder.
 *
 * The production proxy forwards to a single fixed origin and, because
 * production api-auth does not sign the state, passes the callback
 * through with its query string untouched and no verification.
 */
export function createProductionOAuthProxyStub(origin: string) {
  return async function forward(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'GET' || !url.pathname.startsWith('/api/auth/callback/')) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    const destination = new URL(url.pathname, origin);
    destination.search = url.search;
    return new Response(null, { status: 302, headers: { location: destination.toString() } });
  };
}

export function createOAuthProxyStub(secret: string) {
  const encoder = new TextEncoder();

  function decodeBase64Url(value: string): Uint8Array {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  function reject(reason: string): Response {
    return Response.json({ error: 'invalid_proxy_state', reason }, { status: 400 });
  }

  return async function forward(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'GET' || !url.pathname.startsWith('/api/auth/callback/')) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }

    const state = url.searchParams.get('state');
    if (!state) return reject('The state query parameter is required.');
    const [body, signature, extra] = state.split('.');
    if (!body || !signature || extra) return reject('The state is malformed.');

    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, decodeBase64Url(signature), encoder.encode(body)).catch(() => false);
    if (!valid) return reject('The state signature is invalid.');

    let payload: { origin?: unknown; exp?: unknown };
    try {
      payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(body))) as typeof payload;
    } catch {
      return reject('The state payload is not valid JSON.');
    }
    if (typeof payload.origin !== 'string' || typeof payload.exp !== 'number') {
      return reject('The state payload has an invalid shape.');
    }
    if (payload.exp < Date.now()) return reject('The state has expired.');

    const destination = new URL(url.pathname, payload.origin);
    destination.search = url.search;
    return new Response(null, { status: 302, headers: { location: destination.toString() } });
  };
}
