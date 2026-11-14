import type { Db } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import type { SessionSource } from '@karasu-lab/types/shared';
import { eq } from 'drizzle-orm';
import { SessionSourceCreateRepository, SessionSourceGetRepository } from './redis/session-source-repositories';

export interface SessionSourceSignals {
  path: string | null;
  params: Record<string, string | undefined> | null;
}

export class SessionSourceStore {
  private static readonly callbackPath = /\/(?:callback|oauth2\/callback|sso\/callback|sso\/saml2\/(?:sp\/acs|callback))\/([^/?:]+)/;
  private static readonly credentialPath = /^\/sign-in\/(?:email|username)|^\/sign-up\/email/;
  private static readonly passkeyPath = /^\/passkey\//;
  private static readonly unknownProviderId = 'unknown';
  private static readonly maxCachedSources = 1000;
  private static readonly cache = new Map<string, SessionSource>();

  constructor(
    private readonly env: Env,
    private readonly db: Db
  ) {}

  resolveProviderId(signals: SessionSourceSignals): string {
    const path = signals.path ?? '';
    const callback = SessionSourceStore.callbackPath.exec(path);
    if (callback) return signals.params?.id ?? signals.params?.providerId ?? callback[1];
    if (SessionSourceStore.credentialPath.test(path)) return 'credential';
    if (SessionSourceStore.passkeyPath.test(path)) return 'passkey';
    return SessionSourceStore.unknownProviderId;
  }

  async record(session: { id: string; userId: string; expiresAt: Date }, signals: SessionSourceSignals): Promise<void> {
    const source = `${this.resolveProviderId(signals)}-${session.id}`;
    this.remember(session.id, source);
    try {
      await this.db
        .insert(schema.sessionDevicesSource)
        .values({ sessionId: session.id, userId: session.userId, source })
        .onConflictDoNothing();
      await new SessionSourceCreateRepository(this.env).create(session.id, source, session.expiresAt);
    } catch (error) {
      console.error(`Failed to record the session source for session ${session.id}`, error);
    }
  }

  async get(session: { id: string; expiresAt: Date }): Promise<SessionSource> {
    const cached = SessionSourceStore.cache.get(session.id) ?? (await new SessionSourceGetRepository(this.env).get(session.id));
    if (cached?.endsWith(`-${session.id}`)) {
      this.remember(session.id, cached);
      return cached;
    }
    const [row] = await this.db
      .select({ source: schema.sessionDevicesSource.source })
      .from(schema.sessionDevicesSource)
      .where(eq(schema.sessionDevicesSource.sessionId, session.id))
      .limit(1);
    const source = row?.source.endsWith(`-${session.id}`)
      ? row.source
      : `${SessionSourceStore.unknownProviderId}-${session.id}`;
    this.remember(session.id, source);
    await new SessionSourceCreateRepository(this.env).create(session.id, source, session.expiresAt);
    return source;
  }

  private remember(sessionId: string, source: SessionSource): void {
    if (SessionSourceStore.cache.size >= SessionSourceStore.maxCachedSources) SessionSourceStore.cache.clear();
    SessionSourceStore.cache.set(sessionId, source);
  }
}
