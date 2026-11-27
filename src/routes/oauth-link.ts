import { z } from 'zod';
import { createOAuthLinkHandoff, readOAuthLinkHandoff } from '../lib/oauth-link-handoff';
import { createSocialProviders } from '../lib/social-providers';
import { withOAuthProxyState } from '../lib/oauth-proxy';
import { withAuth } from '../lib/request-auth';
import { handleXboxAppLink } from './xbox';

const requestSchema = z.object({
  provider: z.string().max(128).regex(/^[a-z0-9-]+$/i),
  callbackURL: z.string().max(2048),
});

const statePattern = /^[A-Za-z0-9_-]{16,128}$/;

function nativeCallback(callbackURL: string, provider: string): { url: URL } | { reason: string } {
  let url: URL;
  try {
    url = new URL(callbackURL);
  } catch {
    return { reason: 'callbackURL must be a valid URI.' };
  }

  if (url.protocol !== 'karasulab:') return { reason: 'callbackURL must use the karasulab:// scheme.' };
  if (url.hostname !== 'api') return { reason: 'callbackURL host must be api.' };
  if (url.pathname !== `/auth/callback/${provider}`) return { reason: 'callbackURL path must match the requested provider.' };
  if (url.username || url.password || url.port || url.hash) {
    return { reason: 'callbackURL must not contain credentials, a port, or a fragment.' };
  }

  const states = url.searchParams.getAll('state');
  if (states.length !== 1) return { reason: 'callbackURL must contain exactly one state parameter.' };
  if (!statePattern.test(states[0] ?? '')) return { reason: 'callbackURL state must be 16 to 128 URL-safe characters.' };
  if ([...url.searchParams.keys()].some((key) => key !== 'state')) {
    return { reason: 'callbackURL may only contain the state query parameter.' };
  }
  return { url };
}

function inputReason(issues: z.ZodError['issues']): string {
  return issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
}

function providerFailure(response: Response): Promise<{ error: string; reason: string }> {
  return response
    .clone()
    .json()
    .then((body: unknown) => {
      if (typeof body !== 'object' || body === null) {
        return {
          error: 'oauth_link_start_failed',
          reason: `OAuth provider request failed with status ${response.status}.`,
        };
      }
      const record = body as Record<string, unknown>;
      const message = record.reason ?? record.message ?? record.error_description ?? record.error;
      const code = record.error ?? record.code;
      return {
        error: typeof code === 'string' && /^[A-Za-z0-9_-]+$/.test(code) ? code : 'oauth_link_start_failed',
        reason: typeof message === 'string' ? message : `OAuth provider request failed with status ${response.status}.`,
      };
    })
    .catch(() => ({
      error: 'oauth_link_start_failed',
      reason: `OAuth provider request failed with status ${response.status}.`,
    }));
}

export async function handleOAuthLink(env: Env, request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Request body must be valid JSON.';
    return Response.json({ error: 'invalid_oauth_link_request', reason: `Could not parse JSON request body: ${reason}` }, { status: 400 });
  }

  const input = requestSchema.safeParse(body);
  if (!input.success) {
    return Response.json({ error: 'invalid_oauth_link_request', reason: inputReason(input.error.issues) }, { status: 400 });
  }

  const callback = nativeCallback(input.data.callbackURL, input.data.provider);
  if ('reason' in callback) return Response.json({ error: 'invalid_oauth_callback', reason: callback.reason }, { status: 400 });

  const started = await (async () => {
    if (input.data.provider === 'xbox' || input.data.provider === 'minecraft') {
      return handleXboxAppLink(env, request, callback.url.toString(), input.data.provider);
    }

    if (!Object.prototype.hasOwnProperty.call(createSocialProviders(env), input.data.provider)) {
      return Response.json({
        error: 'unsupported_oauth_provider',
        reason: `Provider '${input.data.provider}' is not configured for OAuth linking.`,
      }, { status: 400 });
    }

    const linkCallback = new URL('/auth/callback', env.AUTH_UI_URL);
    linkCallback.searchParams.set('next', callback.url.toString());
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
  })();

  if (!started.ok) {
    return Response.json(await providerFailure(started), { status: started.status });
  }

  let startedBody: unknown;
  try {
    startedBody = await started.json();
  } catch {
    return Response.json({ error: 'oauth_link_start_failed', reason: 'OAuth provider returned an unreadable response.' }, { status: 502 });
  }
  if (typeof startedBody !== 'object' || startedBody === null || !('url' in startedBody) || typeof startedBody.url !== 'string') {
    return Response.json({ error: 'oauth_link_start_failed', reason: 'OAuth provider response did not include an authorization URL.' }, { status: 502 });
  }

  let authorizationURL: URL;
  try {
    authorizationURL = new URL(startedBody.url);
  } catch {
    return Response.json({ error: 'oauth_link_start_failed', reason: 'OAuth provider returned an invalid authorization URL.' }, { status: 502 });
  }
  if (authorizationURL.protocol !== 'https:') {
    return Response.json({ error: 'oauth_link_start_failed', reason: 'OAuth authorization URL must use HTTPS.' }, { status: 502 });
  }

  let ticket: string;
  try {
    ticket = await createOAuthLinkHandoff(env.BETTER_AUTH_SECRET, authorizationURL.toString(), started.headers.getSetCookie());
  } catch (error) {
    console.error('Failed to create OAuth link handoff:', error);
    return Response.json({ error: 'oauth_link_handoff_failed', reason: 'Could not create a secure OAuth handoff.' }, { status: 500 });
  }
  const handoffURL = new URL('/api/oauth/link/continue', env.BETTER_AUTH_URL);
  handoffURL.searchParams.set('ticket', ticket);
  return Response.json({ url: handoffURL.toString() }, { headers: { 'cache-control': 'no-store' } });
}

export async function handleOAuthLinkHandoff(env: Env, request: Request): Promise<Response> {
  const ticket = new URL(request.url).searchParams.get('ticket');
  if (!ticket) return Response.json({ error: 'invalid_oauth_link_handoff', reason: 'The ticket query parameter is required.' }, { status: 400 });

  const handoff = await readOAuthLinkHandoff(env.BETTER_AUTH_SECRET, ticket);
  if (!handoff) {
    return Response.json({ error: 'invalid_oauth_link_handoff', reason: 'The ticket is malformed, expired, or failed integrity validation.' }, { status: 400 });
  }

  const headers = new Headers({
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    location: handoff.url,
  });
  for (const cookie of handoff.cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
}
