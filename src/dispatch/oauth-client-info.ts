import { createDb } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import { waitUntil } from 'cloudflare:workers';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  imageContentTypeSchema,
  intentTokenBodySchema,
  sha256Schema,
  upsertOAuthClientInfoBodySchema,
  type OAuthClientInfoResponse,
} from '@karasu-lab/types/shared';
import { BadRequestError, HttpError, NotFoundError, UnauthorizedError } from '@karasu-lab/types/server';
import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { withAuth } from '../lib/request-auth';
import { SecretRotationNotAllowedError } from '../lib/secret-rotation-error';
import { presignUploadUrl, storageEnv } from '../lib/storage';
import { signUploadIntent, verifyUploadIntent } from '../lib/upload-intent';
import { UploadVerificationError } from '../lib/upload-verification-error';

const prepareIconBodySchema = z.object({
  content_type: imageContentTypeSchema,
  size: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024),
  sha256: sha256Schema,
});

const CLIENT_SECRET_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function generateClientSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => CLIENT_SECRET_ALPHABET[byte % CLIENT_SECRET_ALPHABET.length]).join('');
}

async function hashClientSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function syncClientAuthMethod(
  db: ReturnType<typeof createDb>,
  client: { clientId: string; clientSecret: string | null; grantTypes: string[] | null; tokenEndpointAuthMethod: string | null },
  publicFlag: boolean,
  issueSecret: boolean,
): Promise<string | undefined> {
  const grantTypes = client.grantTypes ?? [];
  const isDeviceClient = grantTypes.includes(DEVICE_CODE_GRANT_TYPE) && !grantTypes.includes('authorization_code');
  const targetAuthMethod = isDeviceClient || publicFlag ? 'none' : 'client_secret_basic';
  const currentAuthMethod = client.tokenEndpointAuthMethod ?? 'client_secret_basic';
  const authMethodIsManaged =
    client.tokenEndpointAuthMethod === null || client.tokenEndpointAuthMethod === 'none' || client.tokenEndpointAuthMethod === 'client_secret_basic';
  if (!authMethodIsManaged || targetAuthMethod === currentAuthMethod) return undefined;
  if (targetAuthMethod === 'none') {
    await db
      .update(schema.oauthClients)
      .set({ tokenEndpointAuthMethod: 'none', clientSecret: null, jwks: null, jwksUri: null, updatedAt: new Date() })
      .where(eq(schema.oauthClients.clientId, client.clientId));
    return undefined;
  }
  if (client.clientSecret) {
    await db
      .update(schema.oauthClients)
      .set({ tokenEndpointAuthMethod: 'client_secret_basic', updatedAt: new Date() })
      .where(eq(schema.oauthClients.clientId, client.clientId));
    return undefined;
  }
  if (!issueSecret) return undefined;
  const newClientSecret = generateClientSecret();
  await db
    .update(schema.oauthClients)
    .set({ tokenEndpointAuthMethod: 'client_secret_basic', clientSecret: await hashClientSecret(newClientSecret), updatedAt: new Date() })
    .where(eq(schema.oauthClients.clientId, client.clientId));
  return newClientSecret;
}

async function ownsClient(env: Env, clientId: string, userId: string): Promise<boolean> {
  const db = createDb(env.DATABASE_URL);
  try {
    const [client] = await db
      .select({ clientId: schema.oauthClients.clientId })
      .from(schema.oauthClients)
      .where(and(eq(schema.oauthClients.clientId, clientId), eq(schema.oauthClients.userId, userId)))
      .limit(1);
    return Boolean(client);
  } finally {
    waitUntil(db.$client.end());
  }
}

export class ListOAuthClientInfoDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname === '/api/oauth-client-info' && this.context.request.method === 'GET';
  }

  async handle(): Promise<Response> {
    const { env, request } = this.context;
    const session = await withAuth(env, (auth) => auth.api.getSession({ headers: request.headers }));
    if (!session) throw new UnauthorizedError();

    const db = createDb(env.DATABASE_URL);
    try {
      const clients = await db
        .select({
          clientId: schema.oauthClients.clientId,
          clientSecret: schema.oauthClients.clientSecret,
          grantTypes: schema.oauthClients.grantTypes,
          tokenEndpointAuthMethod: schema.oauthClients.tokenEndpointAuthMethod,
        })
        .from(schema.oauthClients)
        .where(eq(schema.oauthClients.userId, session.user.id));
      if (clients.length === 0) return Response.json([]);

      const rows = await db
        .select()
        .from(schema.oauthClientInfo)
        .where(
          inArray(
            schema.oauthClientInfo.clientId,
            clients.map((client) => client.clientId)
          )
        );

      const clientById = new Map(clients.map((client) => [client.clientId, client]));
      for (const row of rows) {
        const client = clientById.get(row.clientId);
        if (client) await syncClientAuthMethod(db, client, row.public, false);
      }

      const body: OAuthClientInfoResponse[] = rows.map((row) => ({
        client_id: row.clientId,
        name: row.name,
        author_id: row.authorId,
        icon_url: row.iconUrl,
        description: row.description,
        resource: row.resource,
        public: row.public,
      }));
      return Response.json(body);
    } finally {
      waitUntil(db.$client.end());
    }
  }
}

export class GetOAuthClientInfoDispatch implements Dispatchable {
  private context: DispatchContext;
  private clientId: string | null = null;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    if (!this.context.pathname.startsWith('/api/oauth-client-info/') || this.context.request.method !== 'GET') return false;
    this.clientId = decodeURIComponent(this.context.pathname.slice('/api/oauth-client-info/'.length));
    return true;
  }

  async handle(): Promise<Response> {
    const { env, request } = this.context;
    const clientId = this.clientId as string;
    const session = await withAuth(env, (auth) => auth.api.getSession({ headers: request.headers }));
    if (!session) throw new UnauthorizedError();

    const db = createDb(env.DATABASE_URL);
    try {
      const [client] = await db
        .select({ clientId: schema.oauthClients.clientId })
        .from(schema.oauthClients)
        .where(and(eq(schema.oauthClients.clientId, clientId), eq(schema.oauthClients.userId, session.user.id)))
        .limit(1);
      if (!client) throw new NotFoundError();

      const [row] = await db
        .select()
        .from(schema.oauthClientInfo)
        .where(eq(schema.oauthClientInfo.clientId, clientId))
        .limit(1);
      if (!row) throw new NotFoundError();

      const body: OAuthClientInfoResponse = {
        client_id: row.clientId,
        name: row.name,
        author_id: row.authorId,
        icon_url: row.iconUrl,
        description: row.description,
        resource: row.resource,
        public: row.public,
      };
      return Response.json(body);
    } finally {
      waitUntil(db.$client.end());
    }
  }
}

export class UpsertOAuthClientInfoDispatch implements Dispatchable {
  private context: DispatchContext;
  private clientId: string | null = null;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    if (!this.context.pathname.startsWith('/api/oauth-client-info/') || this.context.request.method !== 'PUT') return false;
    this.clientId = decodeURIComponent(this.context.pathname.slice('/api/oauth-client-info/'.length));
    return true;
  }

  async handle(): Promise<Response> {
    const { env, request } = this.context;
    const clientId = this.clientId as string;
    const session = await withAuth(env, (auth) => auth.api.getSession({ headers: request.headers }));
    if (!session) throw new UnauthorizedError();

    const parsed = upsertOAuthClientInfoBodySchema.safeParse(this.context.body);
    if (!parsed.success) throw new BadRequestError();

    const db = createDb(env.DATABASE_URL);
    try {
      const [client] = await db
        .select({
          clientId: schema.oauthClients.clientId,
          clientSecret: schema.oauthClients.clientSecret,
          grantTypes: schema.oauthClients.grantTypes,
          tokenEndpointAuthMethod: schema.oauthClients.tokenEndpointAuthMethod,
        })
        .from(schema.oauthClients)
        .where(and(eq(schema.oauthClients.clientId, clientId), eq(schema.oauthClients.userId, session.user.id)))
        .limit(1);
      if (!client) throw new NotFoundError();

      const values = {
        name: parsed.data.name,
        iconUrl: parsed.data.icon_url ?? null,
        description: parsed.data.description ?? null,
        resource: parsed.data.resource ?? null,
        public: parsed.data.public ?? false,
      };
      const [previous] = await db
        .select({ resource: schema.oauthClientInfo.resource })
        .from(schema.oauthClientInfo)
        .where(eq(schema.oauthClientInfo.clientId, clientId))
        .limit(1);
      await db
        .insert(schema.oauthClientInfo)
        .values({ clientId, authorId: session.user.id, ...values })
        .onConflictDoUpdate({ target: schema.oauthClientInfo.clientId, set: values });

      const newClientSecret = await syncClientAuthMethod(db, client, values.public, true);

      const findResource = async (identifier: string) => {
        const [row] = await db
          .select({ id: schema.oauthResources.id })
          .from(schema.oauthResources)
          .where(eq(schema.oauthResources.identifier, identifier))
          .limit(1);
        return row;
      };
      const deleteLink = async (resourceId: string) => {
        await db
          .delete(schema.oauthClientResources)
          .where(
            and(
              eq(schema.oauthClientResources.clientId, clientId),
              eq(schema.oauthClientResources.resourceId, resourceId),
            ),
          );
      };
      if (previous?.resource && previous.resource !== values.resource) {
        await deleteLink(previous.resource);
        const previousRow = await findResource(previous.resource);
        if (previousRow && previousRow.id !== previous.resource) {
          await deleteLink(previousRow.id);
        }
      }
      if (values.resource) {
        const now = new Date();
        const row = await findResource(values.resource);
        if (!row) {
          await db.insert(schema.oauthResources).values({
            id: values.resource,
            identifier: values.resource,
            name: values.resource,
            dpopBoundAccessTokensRequired: false,
            disabled: false,
            policyVersion: 1,
            createdAt: now,
            updatedAt: now,
          });
        } else if (row.id !== values.resource) {
          await deleteLink(row.id);
          await db
            .update(schema.oauthResources)
            .set({ id: values.resource })
            .where(eq(schema.oauthResources.identifier, values.resource));
        }
        const [link] = await db
          .select({ id: schema.oauthClientResources.id })
          .from(schema.oauthClientResources)
          .where(
            and(
              eq(schema.oauthClientResources.clientId, clientId),
              eq(schema.oauthClientResources.resourceId, values.resource),
            ),
          )
          .limit(1);
        if (!link) {
          await db.insert(schema.oauthClientResources).values({
            id: crypto.randomUUID(),
            clientId,
            resourceId: values.resource,
            createdAt: now,
          });
        }
      }

      const body: OAuthClientInfoResponse = {
        client_id: clientId,
        name: values.name,
        author_id: session.user.id,
        icon_url: values.iconUrl,
        description: values.description,
        resource: values.resource,
        public: values.public,
        client_secret: newClientSecret,
      };
      return Response.json(body);
    } finally {
      waitUntil(db.$client.end());
    }
  }
}

export class PrepareOAuthClientIconDispatch implements Dispatchable {
  private context: DispatchContext;
  private clientId: string | null = null;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    if (
      !this.context.pathname.startsWith('/api/oauth-client-info/') ||
      !this.context.pathname.endsWith('/icon') ||
      this.context.request.method !== 'POST'
    )
      return false;
    this.clientId = decodeURIComponent(this.context.pathname.slice('/api/oauth-client-info/'.length, -'/icon'.length));
    return true;
  }

  async handle(): Promise<Response> {
    const { env, request } = this.context;
    const clientId = this.clientId as string;
    const session = await withAuth(env, (auth) => auth.api.getSession({ headers: request.headers }));
    if (!session) throw new UnauthorizedError();

    const parsed = prepareIconBodySchema.safeParse(this.context.body);
    if (!parsed.success) throw new BadRequestError();
    if (!(await ownsClient(env, clientId, session.user.id))) throw new NotFoundError();

    const path = `i/oauth/${clientId}/avatar.png`;
    return Response.json({
      upload_url: presignUploadUrl(env, path, parsed.data.content_type),
      intent: signUploadIntent(env, {
        userId: session.user.id,
        clientId,
        path,
        sha256: parsed.data.sha256,
        contentType: parsed.data.content_type,
        size: parsed.data.size,
      }),
    });
  }
}

export class CompleteOAuthClientIconDispatch implements Dispatchable {
  private context: DispatchContext;
  private clientId: string | null = null;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    if (
      !this.context.pathname.startsWith('/api/oauth-client-info/') ||
      !this.context.pathname.endsWith('/icon/complete') ||
      this.context.request.method !== 'POST'
    )
      return false;
    this.clientId = decodeURIComponent(this.context.pathname.slice('/api/oauth-client-info/'.length, -'/icon/complete'.length));
    return true;
  }

  async handle(): Promise<Response> {
    const { env, request } = this.context;
    const clientId = this.clientId as string;
    const session = await withAuth(env, (auth) => auth.api.getSession({ headers: request.headers }));
    if (!session) throw new UnauthorizedError();

    const parsed = intentTokenBodySchema.safeParse(this.context.body);
    if (!parsed.success) throw new BadRequestError();
    const intent = verifyUploadIntent(env, parsed.data.intent, session.user.id, clientId);
    if (!intent) throw new BadRequestError();

    const { token } = await withAuth(env, (auth) => auth.api.getToken({ headers: request.headers }));
    const verified = await fetch(`${env.API_URL}/upload/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        path: intent.path,
        sha256: intent.sha256,
        contentType: intent.contentType,
        size: intent.size,
        uploaderId: session.user.id,
      }),
    });
    if (verified.status === 422) throw new HttpError(422, { error: 'upload_verification_failed' });
    if (!verified.ok) throw new UploadVerificationError();

    const { sha256 } = (await verified.json()) as { sha256: string };
    return Response.json({ icon_url: `${storageEnv(env).CDN_URL}/${intent.path}?v=${sha256.slice(0, 16)}` });
  }
}

const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

const rotateSecretBodySchema = z.object({ client_id: z.string().min(1) });

export async function assertSecretRotationAllowed(env: Env, request: Request): Promise<void> {
  const parsed = rotateSecretBodySchema.safeParse(await request.clone().json().catch(() => null));
  if (!parsed.success) return;
  const clientId = parsed.data.client_id;

  const db = createDb(env.DATABASE_URL);
  try {
    const [client] = await db
      .select({
        grantTypes: schema.oauthClients.grantTypes,
        tokenEndpointAuthMethod: schema.oauthClients.tokenEndpointAuthMethod,
      })
      .from(schema.oauthClients)
      .where(eq(schema.oauthClients.clientId, clientId))
      .limit(1);
    if (!client) return;
    const grantTypes = client.grantTypes ?? [];
    const isDevice = grantTypes.includes(DEVICE_CODE_GRANT_TYPE) && !grantTypes.includes('authorization_code');
    if (isDevice || client.tokenEndpointAuthMethod === 'none') throw new SecretRotationNotAllowedError();
  } finally {
    waitUntil(db.$client.end());
  }
}
