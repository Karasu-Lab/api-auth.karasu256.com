import { z } from 'zod';
import type { Auth } from '../lib/auth';
import { withAuth } from '../lib/request-auth';
import {
  UnknownPermissionError,
  getGrantedPermissions,
  grantPermissions,
  listActivePermissions,
  type ApiKeyCreated,
  type ApiKeySummary,
} from '../lib/permissions-api';

const verifyBodySchema = z.object({ key: z.string().min(1) });
const issueBodySchema = z.object({ userId: z.string().min(1), name: z.string().min(1) });
const createBodySchema = z.object({
  name: z.string().trim().min(1).max(255),
  permissions: z.array(z.string().min(1)).default([]),
});

const badRequest = () => Response.json({ error: 'Bad Request' }, { status: 400 });
const unauthorized = () => Response.json({ error: 'Unauthorized' }, { status: 401 });
const notFound = () => Response.json({ error: 'Not Found' }, { status: 404 });

/** Only key validity is checked here; api.karasu256.com resolves the key's permissions. */
async function verifyApiKey(auth: Auth, key: string): Promise<{ userId: string; keyId: string } | null> {
  const result = await auth.api.verifyApiKey({ body: { key } });
  if (!result.valid || !result.key) return null;
  return { userId: result.key.referenceId, keyId: result.key.id };
}

/**
 * Verifies a raw API key for api.karasu256.com, returning its owner and id.
 *
 * POST /api/api-keys/verify
 * Body: { key: string }
 */
export async function handleVerifyApiKey(env: Env, request: Request): Promise<Response> {
  const parsed = verifyBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest();

  const result = await withAuth(env, (auth) => verifyApiKey(auth, parsed.data.key));
  if (!result) return unauthorized();
  return Response.json(result);
}

/**
 * Issues an API key for a user. `/api/internal/` accepts only requests signed
 * by accounts.karasu256.com, which `rejectInvalidSignature` enforces before
 * this handler runs.
 *
 * POST /api/internal/api-keys
 * Body: { userId: string, name: string }
 */
export async function handleIssueApiKey(env: Env, request: Request): Promise<Response> {
  const parsed = issueBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest();

  const created = await withAuth(env, (auth) => auth.api.createApiKey({ body: { name: parsed.data.name, userId: parsed.data.userId } }));
  return Response.json({
    id: created.id,
    name: created.name ?? null,
    start: created.start ?? null,
    createdAt: new Date(created.createdAt).toISOString(),
    key: created.key,
  });
}

/**
 * Lists the signed-in user's API keys with the permissions granted to
 * each. This endpoint owns the whole read: the keys come from the
 * api-key plugin and the grants are resolved against the permission
 * registry, so the accounts UI no longer reads the key table or the
 * registry itself.
 *
 * GET /api/api-keys
 */
export async function handleListApiKeys(env: Env, request: Request): Promise<Response> {
  return withAuth(env, async (auth) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return unauthorized();

    const { apiKeys } = await auth.api.listApiKeys({ headers: request.headers });
    const granted = await getGrantedPermissions(
      env,
      apiKeys.map((key) => key.id)
    );
    const summaries: ApiKeySummary[] = apiKeys
      .map((key) => ({
        id: key.id,
        name: key.name ?? null,
        start: key.start ?? null,
        createdAt: new Date(key.createdAt).toISOString(),
        lastRequest: key.lastRequest ? new Date(key.lastRequest).toISOString() : null,
        permissions: granted.get(key.id) ?? [],
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Response.json(summaries);
  });
}

/**
 * Issues an API key for the signed-in user and grants it the
 * permissions identified by their public ids. The key is deleted
 * again when the grant fails, so a key never exists without the
 * permissions it was issued for. The raw key is only returned here.
 *
 * POST /api/api-keys
 * Body: { name: string, permissions?: string[] }
 */
export async function handleCreateApiKey(env: Env, request: Request): Promise<Response> {
  const parsed = createBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest();

  return withAuth(env, async (auth) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return unauthorized();

    const created = await auth.api.createApiKey({ body: { name: parsed.data.name, userId: session.user.id } });

    let permissions;
    try {
      permissions = await grantPermissions(env, created.id, parsed.data.permissions);
    } catch (err) {
      await auth.api.deleteApiKey({ body: { keyId: created.id }, headers: request.headers });
      if (err instanceof UnknownPermissionError) return badRequest();
      throw err;
    }

    const body: ApiKeyCreated = {
      id: created.id,
      name: created.name ?? null,
      start: created.start ?? null,
      createdAt: new Date(created.createdAt).toISOString(),
      lastRequest: null,
      permissions,
      key: created.key,
    };
    return Response.json(body, { status: 201 });
  });
}

/**
 * Deletes one of the signed-in user's API keys. The api-key plugin
 * scopes the deletion to the session's own keys.
 *
 * DELETE /api/api-keys/:id
 */
export async function handleDeleteApiKey(env: Env, request: Request, keyId: string): Promise<Response> {
  return withAuth(env, async (auth) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return unauthorized();

    try {
      await auth.api.deleteApiKey({ body: { keyId }, headers: request.headers });
    } catch {
      return notFound();
    }
    return new Response(null, { status: 204 });
  });
}

/**
 * Lists the permissions that can be granted to an API key, proxied
 * from the permission registry so the accounts UI reads everything
 * API-key related from this worker.
 *
 * GET /api/permissions
 */
export async function handleListPermissions(env: Env, request: Request): Promise<Response> {
  return withAuth(env, async (auth) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return unauthorized();

    return Response.json(await listActivePermissions(env));
  });
}
