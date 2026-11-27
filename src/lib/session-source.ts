import type { Db } from '../db/create-db';
import * as schema from '../db/schema';
import { eq } from 'drizzle-orm';
import { SessionSourceCreateRepository, SessionSourceGetRepository } from './redis/session-source-repositories';

export interface SessionSourceSignals {
  path: string | null;
  params: Record<string, string | undefined> | null;
}

export interface SessionSourceInfo {
  raw: string;
  providerId: string;
}

export class SessionSourceStore {
  private static readonly callbackPath = /\/(?:callback|oauth2\/callback|sso\/callback|sso\/saml2\/(?:sp\/acs|callback))\/([^/?:]+)/;
  private static readonly credentialPath = /^\/sign-in\/(?:email|username|email-challenge)|^\/sign-up\/email|^\/email-challenge\/|^\/passkey\//;
  private static readonly socialSignInPath = /^\/sign-in\/social/;
  private static readonly unknownProviderId = 'unknown';
  private static readonly maxCachedSources = 1000;
  private static readonly cache = new Map<string, string>();

  constructor(
    private readonly env: Env,
    private readonly db: Db
  ) {}

  resolveProviderId(signals: SessionSourceSignals): string {
    const path = signals.path ?? '';
    const callback = SessionSourceStore.callbackPath.exec(path);
    if (callback) return signals.params?.id ?? signals.params?.providerId ?? callback[1];
    if (SessionSourceStore.socialSignInPath.test(path)) return signals.params?.provider ?? signals.params?.id ?? signals.params?.providerId ?? SessionSourceStore.unknownProviderId;
    if (SessionSourceStore.credentialPath.test(path)) return 'credential';
    return SessionSourceStore.unknownProviderId;
  }

  async record(session: { id: string; userId: string; expiresAt: Date }, signals: SessionSourceSignals): Promise<void> {
    const source = `${this.resolveProviderId(signals)}-${session.id}`;
    this.remember(session.id, source);
    try {
      await this.db.insert(schema.sessionDevicesSource).values({ sessionId: session.id, userId: session.userId, source }).onConflictDoNothing();
      await new SessionSourceCreateRepository(this.env, session).create(source);
    } catch (error) {
      console.error(`Failed to record the session source for session ${session.id}`, error);
    }
  }

  async get(session: { id: string; userId: string; expiresAt: Date }): Promise<SessionSourceInfo> {
    const cached = SessionSourceStore.cache.get(session.id) ?? (await new SessionSourceGetRepository(this.env, session).get());
    if (cached?.endsWith(`-${session.id}`)) {
      this.remember(session.id, cached);
      return SessionSourceStore.parse(cached, session.id);
    }
    const [row] = await this.db
      .select({ source: schema.sessionDevicesSource.source })
      .from(schema.sessionDevicesSource)
      .where(eq(schema.sessionDevicesSource.sessionId, session.id))
      .limit(1);
    const source = row?.source.endsWith(`-${session.id}`) ? row.source : `${SessionSourceStore.unknownProviderId}-${session.id}`;
    this.remember(session.id, source);
    await new SessionSourceCreateRepository(this.env, session).create(source);
    return SessionSourceStore.parse(source, session.id);
  }

  private static parse(raw: string, sessionId: string): SessionSourceInfo {
    const suffix = `-${sessionId}`;
    const providerId = raw.endsWith(suffix) && raw.length > suffix.length ? raw.slice(0, -suffix.length) : SessionSourceStore.unknownProviderId;
    return { raw, providerId };
  }

  private remember(sessionId: string, source: string): void {
    if (SessionSourceStore.cache.size >= SessionSourceStore.maxCachedSources) SessionSourceStore.cache.clear();
    SessionSourceStore.cache.set(sessionId, source);
  }
}
