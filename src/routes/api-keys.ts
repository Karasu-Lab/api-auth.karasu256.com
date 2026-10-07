import { z } from 'zod';
import type { Auth } from '../lib/auth';
import { withAuth } from '../lib/request-auth';

const verifyBodySchema = z.object({ key: z.string().min(1) });
const issueBodySchema = z.object({ userId: z.string().min(1), name: z.string().min(1) });

const badRequest = () => Response.json({ error: 'Bad Request' }, { status: 400 });
const unauthorized = () => Response.json({ error: 'Unauthorized' }, { status: 401 });

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
