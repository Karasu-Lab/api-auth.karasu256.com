import { Elysia } from 'elysia';
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker';
import { env as cfEnv } from 'cloudflare:workers';
import { resolveEnv } from './constants';
import { handlePreflight, withCors } from './lib/cors';
import { withAuth } from './lib/request-auth';
import { rejectInvalidSignature } from './lib/signature-gate';
import { handleCreateApiKey, handleDeleteApiKey, handleIssueApiKey, handleListApiKeys, handleListPermissions, handleVerifyApiKey } from './routes/api-keys';
import {
  assertSecretRotationAllowed,
  handleCompleteOAuthClientIcon,
  handleListOAuthClientInfo,
  handlePrepareOAuthClientIcon,
  handleUpsertOAuthClientInfo,
} from './routes/oauth-client-info';
import { SecretRotationNotAllowedError } from './lib/secret-rotation-error';
import { handleMcpIconUploadUrl, handleMcpSessionToken } from './routes/mcp';
import { handleProviderDetails } from './routes/providers';
import { handleXboxCallback, handleXboxLink } from './routes/xbox';
import { handleSetPassword } from './routes/set-password';
import { handleSignInLookup } from './routes/sign-in-lookup';
import { rejectUnverifiedTurnstile } from './lib/turnstile';
import { handleCreateTestAccount, handleDeleteTestAccount } from './routes/test-accounts';

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
  const { pathname } = new URL(request.url);

  if (pathname === '/api/auth/set-password') return handleSetPassword(env, request);
  if (pathname.startsWith('/api/auth/')) {
    const rejectedTurnstile = await rejectUnverifiedTurnstile(env, request);
    if (rejectedTurnstile) return rejectedTurnstile;
    if (pathname === '/api/auth/oauth2/client/rotate-secret' && request.method === 'POST') return app.fetch(request);
    return withAuth(env, (auth) => auth.handler(request));
  }
  if (pathname === '/api/api-keys/verify' && request.method === 'POST') return handleVerifyApiKey(env, request);
  if (pathname === '/api/api-keys' && request.method === 'GET') return handleListApiKeys(env, request);
  if (pathname === '/api/api-keys' && request.method === 'POST') return handleCreateApiKey(env, request);
  if (pathname.startsWith('/api/api-keys/') && request.method === 'DELETE')
    return handleDeleteApiKey(env, request, decodeURIComponent(pathname.slice('/api/api-keys/'.length)));
  if (pathname === '/api/permissions' && request.method === 'GET') return handleListPermissions(env, request);
  if (pathname === '/api/oauth-client-info' && request.method === 'GET') return handleListOAuthClientInfo(env, request);
  if (pathname.startsWith('/api/oauth-client-info/') && pathname.endsWith('/icon/complete') && request.method === 'POST')
    return handleCompleteOAuthClientIcon(env, request, decodeURIComponent(pathname.slice('/api/oauth-client-info/'.length, -'/icon/complete'.length)));
  if (pathname.startsWith('/api/oauth-client-info/') && pathname.endsWith('/icon') && request.method === 'POST')
    return handlePrepareOAuthClientIcon(env, request, decodeURIComponent(pathname.slice('/api/oauth-client-info/'.length, -'/icon'.length)));
  if (pathname.startsWith('/api/oauth-client-info/') && request.method === 'PUT')
    return handleUpsertOAuthClientInfo(env, request, decodeURIComponent(pathname.slice('/api/oauth-client-info/'.length)));
  if (pathname === '/api/internal/api-keys' && request.method === 'POST') return handleIssueApiKey(env, request);
  if (pathname === '/api/internal/mcp/session-token' && request.method === 'POST') return handleMcpSessionToken(env, request);
  if (pathname === '/api/internal/mcp/icon-upload-url' && request.method === 'POST') return handleMcpIconUploadUrl(env, request);
  if (pathname === '/api/sign-in/lookup' && request.method === 'GET') return handleSignInLookup(env, request);
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
