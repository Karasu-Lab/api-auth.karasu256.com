import { waitUntil } from 'cloudflare:workers';
import { and, asc, eq } from 'drizzle-orm';
import { createDb, type Db } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import type { Auth } from '../lib/auth';
import {
  AuthorizedAppCreateRepository,
  AuthorizedAppGetRepository,
  type AuthorizedApp,
} from '../lib/redis/authorized-app-repositories';
import { withAuth } from '../lib/request-auth';

async function loadAuthorizedApps(env: Env, auth: Auth, db: Db, userId: string): Promise<AuthorizedApp[]> {
  const cached = await new AuthorizedAppGetRepository(env).get(userId);
  if (cached) return cached;
  const supportedScopes = (await auth.$context).getPlugin('oauth-provider')?.options.scopes ?? [];
  const scopesToPermissions = (scopes: string[]) =>
    supportedScopes.reduce((permissions, scope, index) => (scopes.includes(scope) ? permissions | (1 << index) : permissions), 0);
  const rows = await db
    .select({
      clientId: schema.oauthConsents.clientId,
      scopes: schema.oauthConsents.scopes,
      icon: schema.oauthClients.icon,
      name: schema.oauthClients.name,
    })
    .from(schema.oauthConsents)
    .leftJoin(schema.oauthClients, eq(schema.oauthClients.clientId, schema.oauthConsents.clientId))
    .where(eq(schema.oauthConsents.userId, userId));
  const apps = rows.map((row) => ({ clientId: row.clientId, permissions: scopesToPermissions(row.scopes), icon: row.icon, name: row.name }));
  await new AuthorizedAppCreateRepository(env).create(userId, apps);
  return apps;
}

export async function handleAuthorizedAppList(env: Env, request: Request): Promise<Response> {
  return withAuth(env, async (auth) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const db = createDb(env.DATABASE_URL);
    try {
      const apps = await loadAuthorizedApps(env, auth, db, session.user.id);
      const consents = await db
        .select({ id: schema.oauthConsents.id, clientId: schema.oauthConsents.clientId, createdAt: schema.oauthConsents.createdAt })
        .from(schema.oauthConsents)
        .where(eq(schema.oauthConsents.userId, session.user.id))
        .orderBy(asc(schema.oauthConsents.createdAt));
      return Response.json(
        consents.map((consent) => {
          const app = apps.find((entry) => entry.clientId === consent.clientId);
          return {
            id: consent.id,
            clientId: consent.clientId,
            ...(app?.name ? { clientName: app.name } : {}),
            createdAt: (consent.createdAt ?? new Date(0)).toISOString(),
          };
        })
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
      const [consent] = await db
        .select({
          id: schema.oauthConsents.id,
          clientId: schema.oauthConsents.clientId,
          scopes: schema.oauthConsents.scopes,
          createdAt: schema.oauthConsents.createdAt,
        })
        .from(schema.oauthConsents)
        .where(and(eq(schema.oauthConsents.id, consentId), eq(schema.oauthConsents.userId, session.user.id)));
      if (!consent) return Response.json({ error: 'Not Found' }, { status: 404 });
      const app = (await loadAuthorizedApps(env, auth, db, session.user.id)).find((entry) => entry.clientId === consent.clientId);
      return Response.json({
        id: consent.id,
        clientId: consent.clientId,
        ...(app?.name ? { clientName: app.name } : {}),
        ...(app?.icon ? { logoUri: app.icon } : {}),
        scopes: consent.scopes ?? [],
        createdAt: (consent.createdAt ?? new Date(0)).toISOString(),
      });
    } finally {
      waitUntil(db.$client.end());
    }
  });
}
