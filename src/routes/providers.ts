import { getProviderProfile } from '../lib/provider-profile';
import { withAuth } from '../lib/request-auth';

/**
 * Returns the authenticated user's profile for a single linked provider.
 *
 * GET /api/users/me/providers/:providerId/details
 */
export async function handleProviderDetails(env: Env, request: Request, providerId: string): Promise<Response> {
  return withAuth(env, async (auth) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const profile = await getProviderProfile(auth, session.user.id, providerId);
    if (!profile) return Response.json({ error: 'Not Found' }, { status: 404 });
    return Response.json(profile);
  });
}
