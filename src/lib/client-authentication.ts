import { waitUntil } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { createDb } from '../db/create-db';
import { oauthClients } from '../db/schema';

const CLIENT_AUTHENTICATED_PATHS = new Set(['/api/auth/oauth2/token', '/api/auth/oauth2/introspect', '/api/auth/oauth2/revoke']);

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function readBasicCredentials(header: string | null): { id: string; secret: string } | null {
  if (!header?.startsWith('Basic ')) return null;
  const decoded = atob(header.slice('Basic '.length));
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  return { id: decodeComponent(decoded.slice(0, separator)), secret: decodeComponent(decoded.slice(separator + 1)) };
}

async function registeredMethod(env: Env, clientId: string): Promise<string | null> {
  const db = createDb(env.HYPERDRIVE.connectionString);
  try {
    const [client] = await db.select({ method: oauthClients.tokenEndpointAuthMethod }).from(oauthClients).where(eq(oauthClients.clientId, clientId));
    return client ? (client.method ?? 'client_secret_basic') : null;
  } finally {
    waitUntil(db.$client.end());
  }
}

export async function normalizeClientAuthentication(env: Env, request: Request, pathname: string): Promise<Request> {
  if (request.method !== 'POST' || !CLIENT_AUTHENTICATED_PATHS.has(pathname)) return request;
  if (!request.headers.get('content-type')?.includes('application/x-www-form-urlencoded')) return request;

  const params = new URLSearchParams(await request.clone().text());
  const basic = readBasicCredentials(request.headers.get('authorization'));
  const bodyId = params.get('client_id');
  const bodySecret = params.get('client_secret');
  const presented = basic
    ? { id: basic.id, secret: basic.secret, method: 'client_secret_basic' }
    : bodyId && bodySecret
      ? { id: bodyId, secret: bodySecret, method: 'client_secret_post' }
      : null;
  if (!presented) return request;

  const registered = await registeredMethod(env, presented.id);
  if (!registered || registered === presented.method) return request;

  const headers = new Headers(request.headers);
  if (registered === 'client_secret_basic') {
    params.delete('client_secret');
    params.set('client_id', presented.id);
    headers.set('authorization', `Basic ${btoa(`${encodeURIComponent(presented.id)}:${encodeURIComponent(presented.secret)}`)}`);
  } else if (registered === 'client_secret_post') {
    headers.delete('authorization');
    params.set('client_id', presented.id);
    params.set('client_secret', presented.secret);
  } else {
    return request;
  }
  headers.delete('content-length');
  return new Request(request.url, { method: request.method, headers, body: params.toString() });
}
