import type { ApiKeyCreated, ApiKeySummary, PermissionSummary } from '@karasu-lab/types/shared';
import { UnknownPermissionError } from '@karasu-lab/types/server';

export type { ApiKeyCreated, ApiKeySummary, PermissionSummary };
export { UnknownPermissionError };

function internalHeaders(env: Env): Record<string, string> {
  return { Authorization: `Bearer ${env.INTERNAL_API_SECRET}` };
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`api.karasu256.com responded ${res.status} for ${res.url}`);
  return (await res.json()) as T;
}

export async function listActivePermissions(env: Env): Promise<PermissionSummary[]> {
  return readJson(await fetch(`${env.API_URL}/permissions`, { cache: 'no-store' }));
}

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

export async function getGrantedPermissions(env: Env, apiKeyIds: string[]): Promise<Map<string, PermissionSummary[]>> {
  if (apiKeyIds.length === 0) return new Map();
  const res = await fetch(`${env.API_URL}/internal/api-keys/permissions?ids=${apiKeyIds.map(encodeURIComponent).join(',')}`, {
    headers: internalHeaders(env),
    cache: 'no-store',
  });
  return new Map(Object.entries(await readJson<Record<string, PermissionSummary[]>>(res)));
}
