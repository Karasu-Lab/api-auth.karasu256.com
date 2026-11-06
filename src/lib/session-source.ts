import type { Db } from '@karasu-lab/db/create-db';
import * as schema from '@karasu-lab/db/schema';
import { sessionSourceSchema, type SessionSource } from '@karasu-lab/types/shared';

export const SESSION_SOURCE_HEADER = 'x-session-source';

const MOBILE_USER_AGENT = /(Mobi|Android|iPhone|iPad)/i;
const DESKTOP_USER_AGENT = /Electron/i;
const BROWSER_USER_AGENT = /Mozilla\//i;

export interface SessionSourceSignals {
  path: string | null;
  userAgent: string | null;
  explicit: string | null;
}

export function resolveSessionSource(signals: SessionSourceSignals): SessionSource {
  const explicit = sessionSourceSchema.safeParse(signals.explicit);
  if (explicit.success) return explicit.data;
  if (signals.path?.includes('/device/')) return 'app';
  const userAgent = signals.userAgent ?? '';
  if (MOBILE_USER_AGENT.test(userAgent)) return 'mobile';
  if (DESKTOP_USER_AGENT.test(userAgent)) return 'desktop';
  if (BROWSER_USER_AGENT.test(userAgent)) return 'browser';
  return 'app';
}

export async function recordSessionSource(
  db: Db,
  session: { id: string; userId: string },
  signals: SessionSourceSignals
): Promise<void> {
  try {
    await db
      .insert(schema.sessionDevicesSource)
      .values({ sessionId: session.id, userId: session.userId, source: resolveSessionSource(signals) })
      .onConflictDoNothing();
  } catch (error) {
    console.error(`Failed to record the session source for session ${session.id}`, error);
  }
}
