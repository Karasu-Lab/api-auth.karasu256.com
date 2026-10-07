import { APIError } from 'better-auth/api';
import { z } from 'zod';
import { withAuth } from '../lib/request-auth';

const bodySchema = z.object({ newPassword: z.string().min(1) });

/**
 * Sets a password for the authenticated user's account, linking a
 * `credential` account if one doesn't already exist. `auth.api.setPassword`
 * is server-only in better-auth (unlike `changePassword`, it has no client
 * counterpart), so this route is the only way to expose it to the settings UI.
 *
 * POST /api/auth/set-password
 * Body: { newPassword: string }
 */
export async function handleSetPassword(env: Env, request: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Bad Request' }, { status: 400 });

  try {
    await withAuth(env, (auth) => auth.api.setPassword({ body: { newPassword: parsed.data.newPassword }, headers: request.headers }));
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof APIError ? err.message : 'Failed to set password';
    return Response.json({ error: message }, { status: 400 });
  }
}
