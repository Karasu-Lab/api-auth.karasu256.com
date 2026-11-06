import { z } from 'zod';
import type { Auth } from '../lib/auth';
import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import {
  UnknownPermissionError,
  getGrantedPermissions,
  grantPermissions,
  listActivePermissions,
  type ApiKeyCreated,
  type ApiKeySummary,
} from '../lib/permissions-api';
import { withAuth } from '../lib/request-auth';

const verifyBodySchema = z.object({ key: z.string().min(1) });
const issueBodySchema = z.object({ userId: z.string().min(1), name: z.string().min(1) });
const createBodySchema = z.object({
  name: z.string().trim().min(1).max(255),
  permissions: z.array(z.string().min(1)).default([]),
});

const badRequest = () => Response.json({ error: 'Bad Request' }, { status: 400 });
const unauthorized = () => Response.json({ error: 'Unauthorized' }, { status: 401 });
const notFound = () => Response.json({ error: 'Not Found' }, { status: 404 });

async function verifyApiKey(auth: Auth, key: string): Promise<{ userId: string; keyId: string } | null> {
  const result = await auth.api.verifyApiKey({ body: { key } });
  if (!result.valid || !result.key) return null;
  return { userId: result.key.referenceId, keyId: result.key.id };
}

export class VerifyApiKeyDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname === '/api/api-keys/verify' && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    const { env, request } = this.context;
    const parsed = verifyBodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return badRequest();

    const result = await withAuth(env, (auth) => verifyApiKey(auth, parsed.data.key));
    if (!result) return unauthorized();
    return Response.json(result);
  }
}

export class IssueApiKeyDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname === '/api/internal/api-keys' && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    const { env, request } = this.context;
    const parsed = issueBodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return badRequest();

    const created = await withAuth(env, (auth) => auth.api.createApiKey({ body: { name: parsed.data.name, userId: parsed.data.userId } }));
    return Response.json({
      id: created.id,
      name: created.name ?? null,
      start: created.start ?? null,
      createdAt: new Date(created.createdAt).toISOString(),
      key: created.key,
    });
  }
}

export class ListApiKeysDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname === '/api/api-keys' && this.context.request.method === 'GET';
  }

  async handle(): Promise<Response> {
    const { env, request } = this.context;
    return withAuth(env, async (auth) => {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) return unauthorized();

      const { apiKeys } = await auth.api.listApiKeys({ headers: request.headers });
      const granted = await getGrantedPermissions(
        env,
        apiKeys.map((key) => key.id)
      );
      const summaries: ApiKeySummary[] = apiKeys
        .map((key) => ({
          id: key.id,
          name: key.name ?? null,
          start: key.start ?? null,
          createdAt: new Date(key.createdAt).toISOString(),
          lastRequest: key.lastRequest ? new Date(key.lastRequest).toISOString() : null,
          permissions: granted.get(key.id) ?? [],
        }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return Response.json(summaries);
    });
  }
}

export class CreateApiKeyDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname === '/api/api-keys' && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    const { env, request } = this.context;
    const parsed = createBodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return badRequest();

    return withAuth(env, async (auth) => {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) return unauthorized();

      const created = await auth.api.createApiKey({ body: { name: parsed.data.name, userId: session.user.id } });

      let permissions;
      try {
        permissions = await grantPermissions(env, created.id, parsed.data.permissions);
      } catch (err) {
        await auth.api.deleteApiKey({ body: { keyId: created.id }, headers: request.headers });
        if (err instanceof UnknownPermissionError) return badRequest();
        throw err;
      }

      const body: ApiKeyCreated = {
        id: created.id,
        name: created.name ?? null,
        start: created.start ?? null,
        createdAt: new Date(created.createdAt).toISOString(),
        lastRequest: null,
        permissions,
        key: created.key,
      };
      return Response.json(body, { status: 201 });
    });
  }
}

export class DeleteApiKeyDispatch implements Dispatchable {
  private context: DispatchContext;
  private keyId: string | null = null;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    if (!this.context.pathname.startsWith('/api/api-keys/') || this.context.request.method !== 'DELETE') return false;
    this.keyId = decodeURIComponent(this.context.pathname.slice('/api/api-keys/'.length));
    return true;
  }

  async handle(): Promise<Response> {
    const { env, request } = this.context;
    const keyId = this.keyId as string;
    return withAuth(env, async (auth) => {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) return unauthorized();

      try {
        await auth.api.deleteApiKey({ body: { keyId }, headers: request.headers });
      } catch {
        return notFound();
      }
      return new Response(null, { status: 204 });
    });
  }
}

export class ListPermissionsDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname === '/api/permissions' && this.context.request.method === 'GET';
  }

  async handle(): Promise<Response> {
    const { env, request } = this.context;
    return withAuth(env, async (auth) => {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) return unauthorized();

      return Response.json(await listActivePermissions(env));
    });
  }
}
