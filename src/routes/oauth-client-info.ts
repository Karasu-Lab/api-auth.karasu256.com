import { createDb } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import { waitUntil } from 'cloudflare:workers';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { withAuth } from '../lib/request-auth';
import { presignUploadUrl, storageEnv } from '../lib/storage';
import { signUploadIntent, verifyUploadIntent } from '../lib/upload-intent';
import { UploadVerificationError } from '../lib/upload-verification-error';

const upsertBodySchema = z.object({
  name: z.string().trim().min(1).max(255),
  icon_url: z.string().max(2048).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  resource: z.string().max(2048).nullable().optional(),
});

const prepareIconBodySchema = z.object({
  content_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  size: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const completeIconBodySchema = z.object({ intent: z.string().min(1) });

const badRequest = () => Response.json({ error: 'Bad Request' }, { status: 400 });
const unauthorized = () => Response.json({ error: 'Unauthorized' }, { status: 401 });
const notFound = () => Response.json({ error: 'Not Found' }, { status: 404 });

interface OAuthClientInfoResponse {
  client_id: string;
  name: string;
  author_id: string | null;
  icon_url: string | null;
  description: string | null;
  resource: string | null;
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

export async function handleListOAuthClientInfo(env: Env, request: Request): Promise<Response> {
  const session = await withAuth(env, (auth) => auth.api.getSession({ headers: request.headers }));
  if (!session) return unauthorized();

  const db = createDb(env.DATABASE_URL);
  try {
    const clients = await db
      .select({ clientId: schema.oauthClients.clientId })
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

    const body: OAuthClientInfoResponse[] = rows.map((row) => ({
      client_id: row.clientId,
      name: row.name,
      author_id: row.authorId,
      icon_url: row.iconUrl,
      description: row.description,
      resource: row.resource,
    }));
    return Response.json(body);
  } finally {
    waitUntil(db.$client.end());
  }
}

export async function handleUpsertOAuthClientInfo(env: Env, request: Request, clientId: string): Promise<Response> {
  const session = await withAuth(env, (auth) => auth.api.getSession({ headers: request.headers }));
  if (!session) return unauthorized();

  const parsed = upsertBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest();

  const db = createDb(env.DATABASE_URL);
  try {
    const [client] = await db
      .select({ clientId: schema.oauthClients.clientId })
      .from(schema.oauthClients)
      .where(and(eq(schema.oauthClients.clientId, clientId), eq(schema.oauthClients.userId, session.user.id)))
      .limit(1);
    if (!client) return notFound();

    const values = {
      name: parsed.data.name,
      iconUrl: parsed.data.icon_url ?? null,
      description: parsed.data.description ?? null,
      resource: parsed.data.resource ?? null,
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
    };
    return Response.json(body);
  } finally {
    waitUntil(db.$client.end());
  }
}

export async function handlePrepareOAuthClientIcon(env: Env, request: Request, clientId: string): Promise<Response> {
  const session = await withAuth(env, (auth) => auth.api.getSession({ headers: request.headers }));
  if (!session) return unauthorized();

  const parsed = prepareIconBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest();
  if (!(await ownsClient(env, clientId, session.user.id))) return notFound();

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

export async function handleCompleteOAuthClientIcon(env: Env, request: Request, clientId: string): Promise<Response> {
  const session = await withAuth(env, (auth) => auth.api.getSession({ headers: request.headers }));
  if (!session) return unauthorized();

  const parsed = completeIconBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest();
  const intent = verifyUploadIntent(env, parsed.data.intent, session.user.id, clientId);
  if (!intent) return badRequest();

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
  if (verified.status === 422) return Response.json({ error: 'upload_verification_failed' }, { status: 422 });
  if (!verified.ok) throw new UploadVerificationError();

  const { sha256 } = (await verified.json()) as { sha256: string };
  return Response.json({ icon_url: `${storageEnv(env).CDN_URL}/${intent.path}?v=${sha256.slice(0, 16)}` });
}
