import { Elysia, ParseError } from 'elysia';
import { ZodError } from 'zod';
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker';
import { env as cfEnv } from 'cloudflare:workers';
import { resolveEnv } from './constants';
import { dispatchables } from './dispatch';
import { handlePreflight, withCors } from './lib/cors';
import type { DispatchContext } from './lib/dispatch';
import { HttpError, NotFoundError } from '@karasu-lab/types/server';
import { log } from '@karasu-lab/utils/server/log';
import { withAuth } from './lib/request-auth';
import { rejectInvalidSignature } from './lib/signature-gate';
import { assertSecretRotationAllowed } from './dispatch/oauth-client-info';
import { SecretRotationNotAllowedError } from './lib/secret-rotation-error';
import { UploadVerificationError } from './lib/upload-verification-error';
import { handleProviderDetails, handleProviderList, handleProviderStream } from './routes/providers';
import { handleAuthorizedAppDetails, handleAuthorizedAppList } from './routes/authorized-apps';
import { handleSecuritySettings } from './routes/security';
import { handleXboxAppLink, handleXboxCallback, handleXboxLink } from './routes/xbox';
import { handleOAuthLink, handleOAuthLinkHandoff, handleOAuthSignIn } from './routes/oauth-link';

let resolvedEnv: Env | undefined;
const env = new Proxy({} as Env, {
  get: (_, key) => (resolvedEnv ??= resolveEnv(cfEnv as Env))[key as keyof Env],
});

function handleError(error: unknown, request: Request): Response {
  if (error instanceof SecretRotationNotAllowedError) return Response.json({ error: 'invalid_client', error_description: error.message }, { status: 400 });
  if (error instanceof UploadVerificationError) return Response.json({ error: error.message }, { status: 502 });
  if (error instanceof HttpError)
    return Response.json(error.issues.length > 0 ? { ...error.body, issues: error.issues } : error.body, {
      status: error.status,
      headers: error.headers,
    });
  if (error instanceof ParseError) return Response.json({ error: 'Bad Request' }, { status: 400 });
  log(
    'request_error',
    {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      cause: error instanceof Error && error.cause !== undefined ? String(error.cause) : undefined,
      issues: error instanceof ZodError ? error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) : undefined,
      method: request.method,
      path: new URL(request.url).pathname,
    },
    'error'
  );
  return Response.json({ error: 'Internal Server Error' }, { status: 500 });
}

const app = new Elysia({ adapter: CloudflareAdapter, aot: false, normalize: 'typebox' })
  .parser('none', () => ({}))
  .onError(({ error, request }) => handleError(error, request))
  .get('/api/users/me/providers', ({ request }) => handleProviderList(env, request))
  .get('/api/users/me/providers/stream', ({ request }) => handleProviderStream(env, request))
  .get('/api/users/me/authorized-apps', ({ request }) => handleAuthorizedAppList(env, request))
  .get('/api/users/me/security', ({ request }) => handleSecuritySettings(env, request))
  .get('/api/users/me/authorized-apps/:id', ({ request, params }) => handleAuthorizedAppDetails(env, request, params.id))
  .get('/api/users/me/providers/:providerId/details', ({ request, params }) => handleProviderDetails(env, request, params.providerId))
  .get('/api/auth/callback/xbox', ({ request }) => handleXboxCallback(env, request))
  .post('/api/oauth/link', ({ request }) => handleOAuthLink(env, request))
  .post('/api/oauth/sign-in', ({ request }) => handleOAuthSignIn(env, request))
  .get('/api/oauth/link/continue', ({ request }) => handleOAuthLinkHandoff(env, request))
  .get('/api/xbox/link',({ request }) => handleXboxLink(env, request))
  .post('/api/xbox/link', ({ request }) => handleXboxAppLink(env, request))
  .get('/api/xbox/callback', ({ request }) => handleXboxCallback(env, request))
  .post(
    '/api/auth/oauth2/client/rotate-secret',
    async ({ request }) => {
      await assertSecretRotationAllowed(env, request);
      return withAuth(env, (auth) => auth.handler(request));
    },
    { parse: 'none' }
  )
  .all(
    '/*',
    async ({ request }) => {
      const body =
        request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : await request
              .clone()
              .json()
              .catch(() => null);
      const context: DispatchContext = { env, request, pathname: new URL(request.url).pathname, body };
      for (const Dispatchable of dispatchables) {
        const dispatchable = new Dispatchable(context);
        if (dispatchable.matches()) return dispatchable.handle();
      }
      throw new NotFoundError();
    },
    { parse: 'none' }
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
    try {
      const preflight = await handlePreflight(env, request);
      if (preflight) return preflight;
      const rejected = await rejectInvalidSignature(env, request);
      return await withCors(env, request, rejected ?? (await app.fetch(request)));
    } catch (error) {
      return handleError(error, request);
    }
  },
};
