import { waitUntil } from 'cloudflare:workers';
import { createDb } from '../db/create-db';
import { SseServerStream } from '@karasu-lab/sdk/sse';
import { ProviderStreamEvent, type ProviderStreamEvents } from '@karasu-lab/types/shared';
import { createAuth } from '../lib/auth';
import { getProviderProfile, streamProviderProfiles, type ProviderProfile } from '../lib/provider-profile';
import { withAuth } from '../lib/request-auth';

function profileOptions(env: Env) {
  return {
    microsoftClientId: env.MICROSOFT_CLIENT_ID,
    microsoftClientSecret: env.MICROSOFT_CLIENT_SECRET,
  };
}

export async function handleProviderDetails(env: Env, request: Request, providerId: string): Promise<Response> {
  return withAuth(env, async (auth) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const profile = await getProviderProfile(
      env,
      auth,
      { id: session.session.id, userId: session.user.id, expiresAt: session.session.expiresAt },
      providerId,
      profileOptions(env)
    );
    if (!profile) return Response.json({ error: 'Not Found' }, { status: 404 });
    return Response.json(profile);
  });
}

export async function handleProviderList(env: Env, request: Request): Promise<Response> {
  return withAuth(env, async (auth) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const profiles: Record<string, ProviderProfile | null> = {};
    await streamProviderProfiles(
      env,
      auth,
      { id: session.session.id, userId: session.user.id, expiresAt: session.session.expiresAt },
      (providerId, profile) => {
        profiles[providerId] = profile;
      },
      profileOptions(env)
    );
    return Response.json(profiles);
  });
}

export async function handleProviderStream(env: Env, request: Request): Promise<Response> {
  const db = createDb(env.DATABASE_URL);
  const release = () => waitUntil(db.$client.end());

  try {
    const auth = createAuth(env, db);
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      release();
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return SseServerStream.respond<ProviderStreamEvents>(
      (stream) =>
        streamProviderProfiles(
          env,
          auth,
          { id: session.session.id, userId: session.user.id, expiresAt: session.session.expiresAt },
          (providerId, profile) => stream.send(ProviderStreamEvent.Profile, { providerId, profile }),
          profileOptions(env)
        ),
      { onClose: release }
    );
  } catch (error) {
    release();
    throw error;
  }
}
