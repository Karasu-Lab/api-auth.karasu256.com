import { Elysia, ParseError } from 'elysia';
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker';
import { env as cfEnv } from 'cloudflare:workers';
import { resolveEnv } from './constants';
import { dispatchables } from './dispatch';
import { handlePreflight, withCors } from './lib/cors';
import type { DispatchContext } from './lib/dispatch';
import { HttpError, NotFoundError } from '@karasu-lab/types/server';
import { withAuth } from './lib/request-auth';
import { rejectInvalidSignature } from './lib/signature-gate';
import { assertSecretRotationAllowed } from './dispatch/oauth-client-info';
import { SecretRotationNotAllowedError } from './lib/secret-rotation-error';
import { UploadVerificationError } from './lib/upload-verification-error';
import { handleProviderDetails, handleProviderList } from './routes/providers';
import { handleAuthorizedAppDetails, handleAuthorizedAppList } from './routes/authorized-apps';
import { handleXboxCallback, handleXboxLink } from './routes/xbox';
import { handleGithubAppCallback, handleGithubAppInstall } from './routes/github-app';
import { handleSigningKeyAuthorize, handleSigningKeyCallback } from './routes/signing-key-auth';

const env = resolveEnv(cfEnv as Env);

const app = new Elysia({ adapter: CloudflareAdapter, aot: false, normalize: 'typebox' })
  .onError(({ error }) => {
    if (error instanceof SecretRotationNotAllowedError)
      return Response.json({ error: 'invalid_client', error_description: error.message }, { status: 400 });
    if (error instanceof UploadVerificationError) return Response.json({ error: error.message }, { status: 502 });
    if (error instanceof HttpError) return Response.json(error.body, { status: error.status, headers: error.headers });
    if (error instanceof ParseError) return Response.json({ error: 'Bad Request' }, { status: 400 });
    return Response.json({ error: 'Internal Server Error' }, { status: 500 });
  })
  .get('/api/users/me/providers', ({ request }) => handleProviderList(env, request))
  .get('/api/users/me/authorized-apps', ({ request }) => handleAuthorizedAppList(env, request))
  .get('/api/users/me/authorized-apps/:id', ({ request, params }) => handleAuthorizedAppDetails(env, request, params.id))
  .get('/api/users/me/providers/:providerId/details', ({ request, params }) => handleProviderDetails(env, request, params.providerId))
  .get('/api/xbox/link', ({ request }) => handleXboxLink(env, request))
  .get('/api/xbox/callback', ({ request }) => handleXboxCallback(env, request))
  .get('/api/github-app/install', ({ request }) => handleGithubAppInstall(env, request))
  .get('/api/github-app/callback', ({ request }) => handleGithubAppCallback(env, request))
  .get('/api/signing-keys/authorize', ({ request }) => handleSigningKeyAuthorize(env, request))
  .get('/api/signing-keys/callback', ({ request }) => handleSigningKeyCallback(env, request))
  .post(
    '/api/auth/oauth2/client/rotate-secret',
    async ({ request }) => {
      await assertSecretRotationAllowed(env, request);
      return withAuth(env, (auth) => auth.handler(request));
    },
    { type: 'none' }
  )
  .all(
    '/*',
    async ({ request }) => {
      const body =
        request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.clone().json().catch(() => null);
      const context: DispatchContext = { env, request, pathname: new URL(request.url).pathname, body };
      for (const Dispatchable of dispatchables) {
        const dispatchable = new Dispatchable(context);
        if (dispatchable.matches()) return dispatchable.handle();
      }
      throw new NotFoundError();
    },
    { type: 'none' }
  );

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
