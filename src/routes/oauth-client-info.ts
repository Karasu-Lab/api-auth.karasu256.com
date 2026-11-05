import { createDb } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import { waitUntil } from 'cloudflare:workers';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { withAuth } from '../lib/request-auth';

const upsertBodySchema = z.object({
  name: z.string().trim().min(1).max(255),
  icon_url: z.string().max(2048).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
});

const badRequest = () => Response.json({ error: 'Bad Request' }, { status: 400 });
const unauthorized = () => Response.json({ error: 'Unauthorized' }, { status: 401 });
const notFound = () => Response.json({ error: 'Not Found' }, { status: 404 });

interface OAuthClientInfoResponse {
  client_id: string;
  name: string;
  author_id: string | null;
  icon_url: string | null;
  description: string | null;
}

/**
 * Lists the display info rows for the signed-in user's OAuth clients.
 * The developer settings reference these rows for what a client item
 * shows (name, icon, description) instead of the client record itself.
 *
 * GET /api/oauth-client-info
 */
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
    }));
    return Response.json(body);
  } finally {
    waitUntil(db.$client.end());
  }
}

/**
 * Creates or replaces the display info row for one of the signed-in
 * user's OAuth clients. The accounts developer settings call this
 * right after a client is created or updated, so the row mirrors what
 * the settings show; the author is recorded on first insert. Clients
 * owned by someone else are indistinguishable from missing ones.
 *
 * PUT /api/oauth-client-info/:clientId
 * Body: { name: string, icon_url?: string | null, description?: string | null }
 */
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
    };
    await db
      .insert(schema.oauthClientInfo)
      .values({ clientId, authorId: session.user.id, ...values })
      .onConflictDoUpdate({ target: schema.oauthClientInfo.clientId, set: values });

    const body: OAuthClientInfoResponse = {
      client_id: clientId,
      name: values.name,
      author_id: session.user.id,
      icon_url: values.iconUrl,
      description: values.description,
    };
    return Response.json(body);
  } finally {
    waitUntil(db.$client.end());
  }
}
