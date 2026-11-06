import { createDb } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import { waitUntil } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { withAuth } from '../lib/request-auth';

type Db = ReturnType<typeof createDb>;

async function ensureResourceRow(db: Db, identifier: string): Promise<void> {
  const [row] = await db
    .select({ id: schema.oauthResources.id })
    .from(schema.oauthResources)
    .where(eq(schema.oauthResources.identifier, identifier))
    .limit(1);
  if (!row) {
    const now = new Date();
    await db.insert(schema.oauthResources).values({
      id: identifier,
      identifier,
      name: identifier,
      dpopBoundAccessTokensRequired: false,
      disabled: false,
      policyVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    return;
  }
  if (row.id === identifier) return;

  const staleLinks = await db
    .select({ clientId: schema.oauthClientResources.clientId })
    .from(schema.oauthClientResources)
    .where(eq(schema.oauthClientResources.resourceId, row.id));
  for (const link of staleLinks) {
    const [duplicate] = await db
      .select({ id: schema.oauthClientResources.id })
      .from(schema.oauthClientResources)
      .where(and(eq(schema.oauthClientResources.clientId, link.clientId), eq(schema.oauthClientResources.resourceId, identifier)))
      .limit(1);
    if (duplicate) {
      await db
        .delete(schema.oauthClientResources)
        .where(and(eq(schema.oauthClientResources.clientId, link.clientId), eq(schema.oauthClientResources.resourceId, row.id)));
    } else {
      await db
        .update(schema.oauthClientResources)
        .set({ resourceId: identifier })
        .where(and(eq(schema.oauthClientResources.clientId, link.clientId), eq(schema.oauthClientResources.resourceId, row.id)));
    }
  }
  await db.update(schema.oauthResources).set({ id: identifier }).where(eq(schema.oauthResources.identifier, identifier));
}

async function ensureClientLink(db: Db, clientId: string, identifier: string): Promise<void> {
  const [link] = await db
    .select({ id: schema.oauthClientResources.id })
    .from(schema.oauthClientResources)
    .where(and(eq(schema.oauthClientResources.clientId, clientId), eq(schema.oauthClientResources.resourceId, identifier)))
    .limit(1);
  if (link) return;
  await db.insert(schema.oauthClientResources).values({
    id: crypto.randomUUID(),
    clientId,
    resourceId: identifier,
    createdAt: new Date(),
  });
}

export async function handleClientRegistration(env: Env, request: Request): Promise<Response> {
  const bodyText = await request.clone().text();
  let requested: string[] = [];
  try {
    const parsed = JSON.parse(bodyText) as { resources?: unknown };
    if (Array.isArray(parsed.resources)) {
      requested = parsed.resources.filter((resource): resource is string => typeof resource === 'string' && resource.length > 0);
    }
  } catch {
    requested = [];
  }
  const targets = requested.length > 0 ? [...new Set(requested)] : [env.MCP_URL];

  const db = createDb(env.DATABASE_URL);
  try {
    for (const identifier of targets) await ensureResourceRow(db, identifier);
  } finally {
    waitUntil(db.$client.end());
  }

  const headers = new Headers(request.headers);
  headers.delete('content-length');
  const response = await withAuth(env, (auth) =>
    auth.handler(new Request(request.url, { method: request.method, headers, body: bodyText }))
  );
  if (!response.ok) return response;

  const data = (await response.clone().json().catch(() => null)) as { client_id?: string } | null;
  if (!data?.client_id) return response;

  const linkDb = createDb(env.DATABASE_URL);
  try {
    for (const identifier of targets) await ensureClientLink(linkDb, data.client_id, identifier);
  } finally {
    waitUntil(linkDb.$client.end());
  }
  return response;
}
