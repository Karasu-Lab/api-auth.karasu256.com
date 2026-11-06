import { createDb } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import { waitUntil } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { toHandlerRequest, withAuth } from '../lib/request-auth';

const registrationBodySchema = z.object({ resources: z.array(z.unknown()).catch([]) }).catch({ resources: [] });
const resourceSchema = z.string().min(1);
const registrationResponseSchema = z.object({ client_id: z.string().min(1) });

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

export class ClientRegistrationDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname === '/api/auth/oauth2/register' && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    const { env, request, body } = this.context;
    const requested = registrationBodySchema.parse(body).resources.flatMap((resource) => {
      const parsed = resourceSchema.safeParse(resource);
      return parsed.success ? [parsed.data] : [];
    });
    const targets = requested.length > 0 ? [...new Set(requested)] : [env.MCP_URL];

    const db = createDb(env.DATABASE_URL);
    try {
      for (const identifier of targets) await ensureResourceRow(db, identifier);
    } finally {
      waitUntil(db.$client.end());
    }

    const response = await withAuth(env, (auth) => auth.handler(toHandlerRequest(request, body)));
    if (!response.ok) return response;

    const registration = registrationResponseSchema.safeParse(await response.clone().json().catch(() => null));
    if (!registration.success) return response;

    const linkDb = createDb(env.DATABASE_URL);
    try {
      for (const identifier of targets) await ensureClientLink(linkDb, registration.data.client_id, identifier);
    } finally {
      waitUntil(linkDb.$client.end());
    }
    return response;
  }
}
