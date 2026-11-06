import { Elysia } from 'elysia';
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker';
import { env as cfEnv } from 'cloudflare:workers';
import { resolveEnv } from './constants';
import { dispatchables } from './dispatch';
import { handlePreflight, withCors } from './lib/cors';
import type { DispatchContext } from './lib/dispatch';
import { withAuth } from './lib/request-auth';
import { rejectInvalidSignature } from './lib/signature-gate';
import { assertSecretRotationAllowed } from './dispatch/oauth-client-info';
import { SecretRotationNotAllowedError } from './lib/secret-rotation-error';
import { handleProviderDetails } from './routes/providers';
import { handleXboxCallback, handleXboxLink } from './routes/xbox';

const env = resolveEnv(cfEnv as Env);

const app = new Elysia({ adapter: CloudflareAdapter, aot: false, normalize: 'typebox' })
  .onError(({ error }) => {
    if (error instanceof SecretRotationNotAllowedError)
      return Response.json({ error: 'invalid_client', error_description: error.message }, { status: 400 });
    return Response.json({ error: 'Internal Server Error' }, { status: 500 });
  })
  .get('/api/users/me/providers/:providerId/details', ({ request, params }) => handleProviderDetails(env, request, params.providerId))
  .get('/api/xbox/link', ({ request }) => handleXboxLink(env, request))
  .get('/api/xbox/callback', ({ request }) => handleXboxCallback(env, request))
  .post('/api/auth/oauth2/client/rotate-secret', async ({ request }) => {
    await assertSecretRotationAllowed(env, request);
    return withAuth(env, (auth) => auth.handler(request));
  });

function normalizePath(request: Request): Request {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/{2,}/g, '/');
  if (pathname === url.pathname) return request;
  url.pathname = pathname;
  return new Request(url, request);
}

async function dispatch(request: Request): Promise<Response> {
  const context: DispatchContext = {
    env,
    request,
    pathname: new URL(request.url).pathname,
    fallback: (fallbackRequest) => app.fetch(fallbackRequest),
  };
  for (const Dispatchable of dispatchables) {
    const dispatchable = new Dispatchable(context);
    if (dispatchable.matches()) return dispatchable.handle();
  }
  return context.fallback(request);
}

export default {
  async fetch(rawRequest: Request): Promise<Response> {
    const request = normalizePath(rawRequest);
    const preflight = handlePreflight(env, request);
    if (preflight) return preflight;
    const rejected = await rejectInvalidSignature(env, request);
    return withCors(env, request, rejected ?? (await dispatch(request)));
  },
};
