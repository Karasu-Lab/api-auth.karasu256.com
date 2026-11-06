import { createDb } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import { waitUntil } from 'cloudflare:workers';
import { and, desc, eq, gt } from 'drizzle-orm';
import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { NotFoundError } from '@karasu-lab/types/server';
import { sessionSourceSchema, type AuthSession, type SessionDeviceSource } from '@karasu-lab/types/shared';

const LIST_SESSIONS_PATH = /^\/api\/internal\/users\/([^/]+)\/sessions$/;
const LIST_SOURCES_PATH = /^\/api\/internal\/users\/([^/]+)\/session-sources$/;
const REVOKE_SESSION_PATH = /^\/api\/internal\/users\/([^/]+)\/sessions\/([^/]+)$/;

function pathParam(pathname: string, pattern: RegExp, index: number): string | null {
  const match = pattern.exec(pathname);
  return match ? decodeURIComponent(match[index]) : null;
}

async function withDb<T>(env: Env, fn: (db: ReturnType<typeof createDb>) => Promise<T>): Promise<T> {
  const db = createDb(env.DATABASE_URL);
  try {
    return await fn(db);
  } finally {
    waitUntil(db.$client.end());
  }
}

export class ListAuthSessionsDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.request.method === 'GET' && LIST_SESSIONS_PATH.test(this.context.pathname);
  }

  async handle(): Promise<Response> {
    const userId = pathParam(this.context.pathname, LIST_SESSIONS_PATH, 1) as string;
    const rows = await withDb(this.context.env, (db) =>
      db
        .select()
        .from(schema.sessions)
        .where(and(eq(schema.sessions.userId, userId), gt(schema.sessions.expiresAt, new Date())))
        .orderBy(desc(schema.sessions.createdAt))
    );
    const sessions: AuthSession[] = rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      ipAddress: row.ipAddress ?? null,
      userAgent: row.userAgent ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    }));
    return Response.json(sessions);
  }
}

export class ListSessionDevicesSourceDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.request.method === 'GET' && LIST_SOURCES_PATH.test(this.context.pathname);
  }

  async handle(): Promise<Response> {
    const userId = pathParam(this.context.pathname, LIST_SOURCES_PATH, 1) as string;
    const rows = await withDb(this.context.env, (db) =>
      db.select().from(schema.sessionDevicesSource).where(eq(schema.sessionDevicesSource.userId, userId))
    );
    const sources: SessionDeviceSource[] = [];
    for (const row of rows) {
      const source = sessionSourceSchema.safeParse(row.source);
      if (source.success) sources.push({ sessionId: row.sessionId, userId: row.userId, source: source.data });
    }
    return Response.json(sources);
  }
}

export class RevokeAuthSessionDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.request.method === 'DELETE' && REVOKE_SESSION_PATH.test(this.context.pathname);
  }

  async handle(): Promise<Response> {
    const userId = pathParam(this.context.pathname, REVOKE_SESSION_PATH, 1) as string;
    const sessionId = pathParam(this.context.pathname, REVOKE_SESSION_PATH, 2) as string;
    const deleted = await withDb(this.context.env, (db) =>
      db
        .delete(schema.sessions)
        .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, userId)))
        .returning({ id: schema.sessions.id })
    );
    if (deleted.length === 0) throw new NotFoundError();
    return new Response(null, { status: 204 });
  }
}
