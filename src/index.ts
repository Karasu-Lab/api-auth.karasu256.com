import { Elysia } from 'elysia';
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker';
import { env as cfEnv } from 'cloudflare:workers';
import { handlePreflight, withCors } from './lib/cors';
import { withAuth } from './lib/request-auth';
import { rejectInvalidSignature } from './lib/signature-gate';
import { handleIssueApiKey, handleVerifyApiKey } from './routes/api-keys';
import { handleProviderDetails } from './routes/providers';
import { handleSetPassword } from './routes/set-password';
import { handleCreateTestAccount, handleDeleteTestAccount } from './routes/test-accounts';

const env = cfEnv as Env;

/** Workers do not allow generating code at runtime. */
const app = new Elysia({ adapter: CloudflareAdapter, aot: false, normalize: 'typebox' }).get(
  '/api/users/me/providers/:providerId/details',
  ({ request, params }) => handleProviderDetails(env, request, params.providerId)
);

/** Collapses repeated slashes so a caller's base URL with a trailing slash still reaches the route. */
function normalizePath(request: Request): Request {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/{2,}/g, '/');
  if (pathname === url.pathname) return request;
  url.pathname = pathname;
  return new Request(url, request);
}

/**
 * Routes that read the raw request body (better-auth's own handler, key
 * verification and the signed internal route) are dispatched here, before
 * Elysia can consume it.
 */
async function dispatch(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === '/api/auth/set-password') return handleSetPassword(env, request);
  if (pathname.startsWith('/api/auth/')) return withAuth(env, (auth) => auth.handler(request));
  if (pathname === '/api/api-keys/verify' && request.method === 'POST') return handleVerifyApiKey(env, request);
  if (pathname === '/api/internal/api-keys' && request.method === 'POST') return handleIssueApiKey(env, request);
  if (pathname === '/api/test/accounts' && request.method === 'POST') return handleCreateTestAccount(env, request);
  if (pathname === '/api/test/accounts' && request.method === 'DELETE') return handleDeleteTestAccount(env, request);
  return app.fetch(request);
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
