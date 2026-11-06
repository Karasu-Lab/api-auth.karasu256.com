import { Elysia } from 'elysia';
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker';
import { env as cfEnv } from 'cloudflare:workers';
import { resolveEnv } from './constants';
import { dispatchables } from './dispatch';
import { handlePreflight, withCors } from './lib/cors';
import type { DispatchContext } from './lib/dispatch';
import { HttpError } from './lib/errors';
import { withAuth } from './lib/request-auth';
import { rejectInvalidSignature } from './lib/signature-gate';
import { assertSecretRotationAllowed } from './dispatch/oauth-client-info';
import { SecretRotationNotAllowedError } from './lib/secret-rotation-error';
import { UploadVerificationError } from './lib/upload-verification-error';
import { handleProviderDetails } from './routes/providers';
import { handleXboxCallback, handleXboxLink } from './routes/xbox';

const env = resolveEnv(cfEnv as Env);

function withParsedBody(request: Request, body: unknown): Request {
  if (body === undefined) return request;
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  return new Request(request.url, {
    method: request.method,
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const app = new Elysia({ adapter: CloudflareAdapter, aot: false, normalize: 'typebox' })
  .onError(({ code, error }) => {
    if (error instanceof SecretRotationNotAllowedError)
      return Response.json({ error: 'invalid_client', error_description: error.message }, { status: 400 });
    if (error instanceof UploadVerificationError) return Response.json({ error: error.message }, { status: 502 });
    if (error instanceof HttpError) return Response.json(error.body, { status: error.status, headers: error.headers });
    if (code === 'PARSE') return Response.json({ error: 'Bad Request' }, { status: 400 });
    return Response.json({ error: 'Internal Server Error' }, { status: 500 });
  })
  .get('/api/users/me/providers/:providerId/details', ({ request, params }) => handleProviderDetails(env, request, params.providerId))
  .get('/api/xbox/link', ({ request }) => handleXboxLink(env, request))
  .get('/api/xbox/callback', ({ request }) => handleXboxCallback(env, request))
  .post('/api/auth/oauth2/client/rotate-secret', async ({ request, body }) => {
    const effectiveRequest = withParsedBody(request, body);
    await assertSecretRotationAllowed(env, effectiveRequest);
    return withAuth(env, (auth) => auth.handler(effectiveRequest));
  })
  .all('/*', async ({ request, body }) => {
    const effectiveRequest = withParsedBody(request, body);
    const context: DispatchContext = { env, request: effectiveRequest, pathname: new URL(effectiveRequest.url).pathname };
    for (const Dispatchable of dispatchables) {
      const dispatchable = new Dispatchable(context);
      if (dispatchable.matches()) return dispatchable.handle();
    }
    return new Response('NOT_FOUND', { status: 404 });
  });

function normalizePath(request: Request): Request {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/{2,}/g, '/');
  if (pathname === url.pathname) return request;
  url.pathname = pathname;
  return new Request(url, request);
}

export default {
  async fetch(rawRequest: Request): Promise<Response> {
    const request = normalizePath(rawRequest);
    const preflight = handlePreflight(env, request);
    if (preflight) return preflight;
    const rejected = await rejectInvalidSignature(env, request);
    return withCors(env, request, rejected ?? (await app.fetch(request)));
  },
};
