import { APIError } from 'better-auth/api';
import { parseCookies } from 'better-auth/cookies';

/** The error code a sign-in is rejected with when it conflicts with a session this device already holds. */
export const DEVICE_SESSION_CONFLICT_CODE = 'account_already_signed_in';

/**
 * The device-session reads the conflict check needs, supplied by the
 * session creation hook from the endpoint context it runs in.
 */
export interface DeviceSessionSource {
  /** The request's cookie header, or null when the request carries none. */
  cookieHeader: string | null;
  /** Reads and verifies one signed cookie by name; a failed verification reads as false. */
  getSignedCookie: (name: string) => Promise<string | false | null>;
  /** Resolves session tokens to their active sessions, following the internal adapter's shape. */
  findSessions: (tokens: string[]) => Promise<({ user: { id: string }; session: { expiresAt: Date } } | null)[]>;
}

/**
 * Rejects a session creation that would conflict with the sessions this
 * device already holds. Under `multiSession`, a sign-in is how an account
 * is added to the device, and the plugin replaces the previous session
 * when the account being signed in already has one here — so the addition
 * has to be rejected before a session exists, leaving the device's
 * sessions untouched, instead of being detected after the fact. The
 * rejection is the whole answer the client needs: an error response with
 * {@link DEVICE_SESSION_CONFLICT_CODE}, and no session is created.
 */
export async function assertNoDeviceSessionConflict(source: DeviceSessionSource, userId: string): Promise<void> {
  if (!source.cookieHeader) return;
  const tokens = (
    await Promise.all(
      [...parseCookies(source.cookieHeader).keys()]
        .filter((name) => name.includes('_multi-'))
        .map((name) => source.getSignedCookie(name)),
    )
  ).filter((token): token is string => typeof token === 'string');
  if (tokens.length === 0) return;
  const deviceSessions = await source.findSessions(tokens);
  const conflict = deviceSessions.some((entry) => entry !== null && entry.session.expiresAt > new Date() && entry.user.id === userId);
  if (!conflict) return;
  throw APIError.from('CONFLICT', {
    code: DEVICE_SESSION_CONFLICT_CODE,
    message: 'This account is already signed in on this device.',
  });
}
