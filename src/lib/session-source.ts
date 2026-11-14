import type { Db } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import type { SessionSource } from '@karasu-lab/types/shared';
import { eq } from 'drizzle-orm';

export interface SessionSourceSignals {
  path: string | null;
  params: Record<string, string> | null;
}

export class SessionSourceStore {
  private static readonly callbackPath = /\/(?:callback|oauth2\/callback|sso\/callback|sso\/saml2\/(?:sp\/acs|callback))\/([^/?:]+)/;
  private static readonly credentialPath = /^\/sign-in\/(?:email|username)|^\/sign-up\/email/;
  private static readonly passkeyPath = /^\/passkey\//;
  private static readonly unknownProviderId = 'unknown';
  private static readonly maxCachedSources = 1000;
  private static readonly cache = new Map<string, SessionSource>();

  constructor(private readonly db: Db) {}

  resolveProviderId(signals: SessionSourceSignals): string {
    const path = signals.path ?? '';
    const callback = SessionSourceStore.callbackPath.exec(path);
    if (callback) return signals.params?.id ?? signals.params?.providerId ?? callback[1];
    if (SessionSourceStore.credentialPath.test(path)) return 'credential';
    if (SessionSourceStore.passkeyPath.test(path)) return 'passkey';
    return SessionSourceStore.unknownProviderId;
  }

  async record(session: { id: string; userId: string }, signals: SessionSourceSignals): Promise<void> {
    const source = `${this.resolveProviderId(signals)}-${session.id}`;
    this.remember(session.id, source);
    try {
      await this.db
        .insert(schema.sessionDevicesSource)
        .values({ sessionId: session.id, userId: session.userId, source })
        .onConflictDoNothing();
    } catch (error) {
      console.error(`Failed to record the session source for session ${session.id}`, error);
    }
  }

  async get(sessionId: string): Promise<SessionSource> {
    const cached = SessionSourceStore.cache.get(sessionId);
    if (cached) return cached;
    const [row] = await this.db
      .select({ source: schema.sessionDevicesSource.source })
      .from(schema.sessionDevicesSource)
      .where(eq(schema.sessionDevicesSource.sessionId, sessionId))
      .limit(1);
    const source = row?.source.endsWith(`-${sessionId}`)
      ? row.source
      : `${SessionSourceStore.unknownProviderId}-${sessionId}`;
    this.remember(sessionId, source);
    return source;
  }

  private remember(sessionId: string, source: SessionSource): void {
    if (SessionSourceStore.cache.size >= SessionSourceStore.maxCachedSources) SessionSourceStore.cache.clear();
    SessionSourceStore.cache.set(sessionId, source);
  }
}
