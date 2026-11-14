import { createDb } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import { waitUntil } from 'cloudflare:workers';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import {
  ActiveSessionCreateRepository,
  ActiveSessionGetRepository,
  type ActiveSession,
} from '../lib/redis/active-session-repositories';
import { withAuth } from '../lib/request-auth';
import { BadRequestError, NotFoundError } from '@karasu-lab/types/server';
import type { AuthSession, SessionDeviceSource } from '@karasu-lab/types/shared';

const LIST_SESSIONS_PATH = /^\/api\/internal\/users\/([^/]+)\/sessions$/;
const LIST_SOURCES_PATH = /^\/api\/internal\/users\/([^/]+)\/session-sources$/;
const REVOKE_SESSION_PATH = /^\/api\/internal\/users\/([^/]+)\/sessions\/([^/]+)$/;

const sessionFilterSchema = z.object({
  userId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
});

type SessionFilter = z.infer<typeof sessionFilterSchema>;

function pathParam(pathname: string, pattern: RegExp, index: number): string | null {
  const match = pattern.exec(pathname);
  return match ? decodeURIComponent(match[index]) : null;
}

function sessionFilter(context: DispatchContext, userId: string | null): SessionFilter {
  const sessionId = new URL(context.request.url).searchParams.get('sessionId');
  const parsed = sessionFilterSchema.safeParse({ userId, ...(sessionId !== null ? { sessionId } : {}) });
  if (!parsed.success) throw new BadRequestError();
  return parsed.data;
}

function revokeFilter(context: DispatchContext): SessionFilter & { sessionId: string } {
  const parsed = sessionFilterSchema.safeParse({
    userId: pathParam(context.pathname, REVOKE_SESSION_PATH, 1),
    sessionId: pathParam(context.pathname, REVOKE_SESSION_PATH, 2),
  });
  if (!parsed.success || !parsed.data.sessionId) throw new BadRequestError();
  return parsed.data as SessionFilter & { sessionId: string };
}

async function withDb<T>(env: Env, fn: (db: ReturnType<typeof createDb>) => Promise<T>): Promise<T> {
  const db = createDb(env.DATABASE_URL);
  try {
    return await fn(db);
  } finally {
    waitUntil(db.$client.end());
  }
}

async function loadActiveSessions(env: Env, userId: string): Promise<ActiveSession[]> {
  const cached = await new ActiveSessionGetRepository(env).get(userId);
  if (cached) return cached;
  const rows = await withDb(env, (db) =>
    db
      .select({ id: schema.sessions.id, source: schema.sessionDevicesSource.source, createdAt: schema.sessions.createdAt })
      .from(schema.sessions)
      .leftJoin(schema.sessionDevicesSource, eq(schema.sessionDevicesSource.sessionId, schema.sessions.id))
      .where(and(eq(schema.sessions.userId, userId), gt(schema.sessions.expiresAt, new Date())))
      .orderBy(desc(schema.sessions.createdAt))
  );
  const sessions = rows.map((row) => ({ id: row.id, source: row.source ?? `unknown-${row.id}`, createdAt: row.createdAt.toISOString() }));
  await new ActiveSessionCreateRepository(env).create(userId, sessions);
  return sessions;
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
    const filter = sessionFilter(this.context, pathParam(this.context.pathname, LIST_SESSIONS_PATH, 1));
    const active = (await loadActiveSessions(this.context.env, filter.userId)).filter(
      (session) => !filter.sessionId || session.id === filter.sessionId
    );
    if (active.length === 0) return Response.json([]);
    const rows = await withDb(this.context.env, (db) =>
      db
        .select({
          id: schema.sessions.id,
          ipAddress: schema.sessions.ipAddress,
          userAgent: schema.sessions.userAgent,
          updatedAt: schema.sessions.updatedAt,
          expiresAt: schema.sessions.expiresAt,
        })
        .from(schema.sessions)
        .where(and(inArray(schema.sessions.id, active.map((session) => session.id)), gt(schema.sessions.expiresAt, new Date())))
    );
    const sessions: AuthSession[] = active.flatMap((session) => {
      const row = rows.find((entry) => entry.id === session.id);
      if (!row) return [];
      return [
        {
          id: session.id,
          userId: filter.userId,
          ipAddress: row.ipAddress ?? null,
          userAgent: row.userAgent ?? null,
          createdAt: session.createdAt,
          updatedAt: row.updatedAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
        },
      ];
    });
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
    const filter = sessionFilter(this.context, pathParam(this.context.pathname, LIST_SOURCES_PATH, 1));
    const sources: SessionDeviceSource[] = (await loadActiveSessions(this.context.env, filter.userId))
      .filter((session) => !filter.sessionId || session.id === filter.sessionId)
      .map((session) => ({ sessionId: session.id, userId: filter.userId, source: session.source }));
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
    const filter = revokeFilter(this.context);
    const [session] = await withDb(this.context.env, (db) =>
      db
        .select({ token: schema.sessions.token })
        .from(schema.sessions)
        .where(and(eq(schema.sessions.id, filter.sessionId), eq(schema.sessions.userId, filter.userId)))
        .limit(1)
    );
    if (!session) throw new NotFoundError();
    await withAuth(this.context.env, async (auth) => (await auth.$context).internalAdapter.deleteSession(session.token));
    return new Response(null, { status: 204 });
  }
}
