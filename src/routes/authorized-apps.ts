import { waitUntil } from 'cloudflare:workers';
import { and, asc, eq } from 'drizzle-orm';
import { createDb } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import { withAuth } from '../lib/request-auth';

export async function handleAuthorizedAppList(env: Env, request: Request): Promise<Response> {
  return withAuth(env, async (auth) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const db = createDb(env.DATABASE_URL);
    try {
      const rows = await db
        .select({
          id: schema.oauthConsents.id,
          clientId: schema.oauthConsents.clientId,
          clientName: schema.oauthClients.name,
          createdAt: schema.oauthConsents.createdAt,
        })
        .from(schema.oauthConsents)
        .leftJoin(schema.oauthClients, eq(schema.oauthClients.clientId, schema.oauthConsents.clientId))
        .where(eq(schema.oauthConsents.userId, session.user.id))
        .orderBy(asc(schema.oauthConsents.createdAt));
      return Response.json(
        rows.map((row) => ({
          id: row.id,
          clientId: row.clientId,
          ...(row.clientName ? { clientName: row.clientName } : {}),
          createdAt: (row.createdAt ?? new Date(0)).toISOString(),
        }))
      );
    } finally {
      waitUntil(db.$client.end());
    }
  });
}

export async function handleAuthorizedAppDetails(env: Env, request: Request, consentId: string): Promise<Response> {
  return withAuth(env, async (auth) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const db = createDb(env.DATABASE_URL);
    try {
      const rows = await db
        .select({
          id: schema.oauthConsents.id,
          clientId: schema.oauthConsents.clientId,
          clientName: schema.oauthClients.name,
          logoUri: schema.oauthClients.icon,
          scopes: schema.oauthConsents.scopes,
          createdAt: schema.oauthConsents.createdAt,
        })
        .from(schema.oauthConsents)
        .leftJoin(schema.oauthClients, eq(schema.oauthClients.clientId, schema.oauthConsents.clientId))
        .where(and(eq(schema.oauthConsents.id, consentId), eq(schema.oauthConsents.userId, session.user.id)));
      const row = rows[0];
      if (!row) return Response.json({ error: 'Not Found' }, { status: 404 });
      return Response.json({
        id: row.id,
        clientId: row.clientId,
        ...(row.clientName ? { clientName: row.clientName } : {}),
        ...(row.logoUri ? { logoUri: row.logoUri } : {}),
        scopes: row.scopes ?? [],
        createdAt: (row.createdAt ?? new Date(0)).toISOString(),
      });
    } finally {
      waitUntil(db.$client.end());
    }
  });
}
