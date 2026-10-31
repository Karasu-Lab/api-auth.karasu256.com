/**
 * Client for api.karasu256.com's permission registry, used by the
 * user-facing API key endpoints. Permission grants are internal
 * operations, so they carry the shared service secret rather than a
 * user credential. The response shapes mirror the
 * `@karasu-lab/api-permissions` types the accounts UI consumes; this
 * worker does not depend on that package, so they are declared here.
 */

export interface PermissionSummary {
  publicId: string;
  numericId: number;
  resource: string;
  action: string;
}

export interface ApiKeySummary {
  id: string;
  name: string | null;
  start: string | null;
  createdAt: string;
  lastRequest: string | null;
  permissions: PermissionSummary[];
}

export interface ApiKeyCreated extends ApiKeySummary {
  key: string;
}

/** Thrown when a grant names a permission public id the registry does not know. */
export class UnknownPermissionError extends Error {
  constructor() {
    super('Unknown permission');
    this.name = 'UnknownPermissionError';
  }
}

function internalHeaders(env: Env): Record<string, string> {
  return { Authorization: `Bearer ${env.INTERNAL_API_SECRET}` };
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`api.karasu256.com responded ${res.status} for ${res.url}`);
  return (await res.json()) as T;
}

/** Lists the permissions that exist and can be granted to an API key. */
export async function listActivePermissions(env: Env): Promise<PermissionSummary[]> {
  return readJson(await fetch(`${env.API_URL}/permissions`, { cache: 'no-store' }));
}

/** Grants the permissions identified by their public ids to an API key. */
export async function grantPermissions(env: Env, apiKeyId: string, publicIds: string[]): Promise<PermissionSummary[]> {
  const res = await fetch(`${env.API_URL}/internal/api-keys/${encodeURIComponent(apiKeyId)}/permissions`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...internalHeaders(env) },
    body: JSON.stringify({ permissions: publicIds }),
    cache: 'no-store',
  });
  if (res.status === 400) throw new UnknownPermissionError();
  return readJson<PermissionSummary[]>(res);
}

/** Resolves the permissions granted to each of the given API keys. */
export async function getGrantedPermissions(env: Env, apiKeyIds: string[]): Promise<Map<string, PermissionSummary[]>> {
  if (apiKeyIds.length === 0) return new Map();
  const res = await fetch(`${env.API_URL}/internal/api-keys/permissions?ids=${apiKeyIds.map(encodeURIComponent).join(',')}`, {
    headers: internalHeaders(env),
    cache: 'no-store',
  });
  return new Map(Object.entries(await readJson<Record<string, PermissionSummary[]>>(res)));
}
