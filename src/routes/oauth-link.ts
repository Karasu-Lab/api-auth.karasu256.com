import { z } from 'zod';
import { createOAuthLinkHandoff, readOAuthLinkHandoff } from '../lib/oauth-link-handoff';
import { createSocialProviders } from '../lib/social-providers';
import { withOAuthProxyState } from '../lib/oauth-proxy';
import { withAuth } from '../lib/request-auth';
import { handleXboxAppLink } from './xbox';

const requestSchema = z.object({
  provider: z.string().max(128).regex(/^[a-z0-9-]+$/i),
  callbackURL: z.string().max(2048).url(),
});

const statePattern = /^[A-Za-z0-9_-]{16,128}$/;

function nativeCallback(callbackURL: string, provider: string): URL | null {
  let url: URL;
  try {
    url = new URL(callbackURL);
  } catch {
    return null;
  }

  const states = url.searchParams.getAll('state');
  if (
    url.protocol !== 'karasulab:' ||
    url.hostname !== 'api' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.pathname !== `/auth/callback/${provider}` ||
    states.length !== 1 ||
    !statePattern.test(states[0] ?? '') ||
    [...url.searchParams.keys()].some((key) => key !== 'state')
  ) {
    return null;
  }
  return url;
}

export async function handleOAuthLink(env: Env, request: Request): Promise<Response> {
  const input = requestSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return Response.json({ error: 'invalid_oauth_link_request' }, { status: 400 });

  const callback = nativeCallback(input.data.callbackURL, input.data.provider);
  if (!callback) return Response.json({ error: 'invalid_oauth_callback' }, { status: 400 });

  const started = await (async () => {
    if (input.data.provider === 'xbox' || input.data.provider === 'minecraft') {
      return handleXboxAppLink(env, request, callback.toString(), input.data.provider);
    }

    if (!Object.prototype.hasOwnProperty.call(createSocialProviders(env), input.data.provider)) {
      return Response.json({ error: 'unsupported_oauth_provider' }, { status: 400 });
    }

    const linkCallback = new URL('/auth/callback', env.AUTH_UI_URL);
    linkCallback.searchParams.set('next', callback.toString());
    linkCallback.searchParams.set('flow', 'link');

    return withAuth(env, async (auth) => {
      const headers = new Headers(request.headers);
      headers.set('content-type', 'application/json');
      headers.delete('content-length');
      const authRequest = new Request(`${env.BETTER_AUTH_URL.replace(/\/+$/, '')}/api/auth/link-social`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          provider: input.data.provider,
          callbackURL: linkCallback.toString(),
          errorCallbackURL: linkCallback.toString(),
          disableRedirect: true,
        }),
      });
      return withOAuthProxyState(env, 'POST', '/api/auth/link-social', await auth.handler(authRequest));
    });
  });

  if (!started.ok) return started;
  const body = (await started.json()) as { url?: string };
  if (!body.url) return Response.json({ error: 'oauth_link_start_failed' }, { status: 502 });
  const ticket = await createOAuthLinkHandoff(env.BETTER_AUTH_SECRET, body.url, started.headers.getSetCookie());
  const handoffURL = new URL('/api/oauth/link/continue', env.BETTER_AUTH_URL);
  handoffURL.searchParams.set('ticket', ticket);
  return Response.json({ url: handoffURL.toString() }, { headers: { 'cache-control': 'no-store' } });
}

export async function handleOAuthLinkHandoff(env: Env, request: Request): Promise<Response> {
  const ticket = new URL(request.url).searchParams.get('ticket');
  if (!ticket) return Response.json({ error: 'invalid_oauth_link_handoff' }, { status: 400 });

  const handoff = await readOAuthLinkHandoff(env.BETTER_AUTH_SECRET, ticket);
  if (!handoff) return Response.json({ error: 'invalid_oauth_link_handoff' }, { status: 400 });

  const headers = new Headers({
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    location: handoff.url,
  });
  for (const cookie of handoff.cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
}
