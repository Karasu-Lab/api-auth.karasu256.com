import { HttpError } from '@karasu-lab/types/server';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import { SessionExpiryGetRepository } from './redis/session-expiry-repositories';

export async function isSessionExpired(env: Env, sessionId: string): Promise<boolean> {
  const expiresAt = await new SessionExpiryGetRepository(env).get(sessionId);
  return expiresAt !== null && expiresAt <= Date.now();
}

export async function assertTokenSessionActive(env: Env, response: Response): Promise<void> {
  if (!response.ok) return;
  const token = z.object({ access_token: z.string() }).safeParse(await response.clone().json().catch(() => null));
  if (!token.success) return;
  let sessionId: string;
  try {
    sessionId = z.object({ sid: z.string() }).parse(decodeJwt(token.data.access_token)).sid;
  } catch {
    return;
  }
  if (await isSessionExpired(env, sessionId)) throw new HttpError(400, { error: 'invalid_grant', error_description: 'session_expired' });
}
