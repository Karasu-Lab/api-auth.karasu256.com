import { APIError } from 'better-auth/api';
import { parseCookies } from 'better-auth/cookies';
import { z } from 'zod';
import type { DeviceSessionSource } from '@karasu-lab/types/server';

export type { DeviceSessionSource };

export const DEVICE_SESSION_CONFLICT_CODE = 'account_already_signed_in';

export async function assertNoDeviceSessionConflict(source: DeviceSessionSource, userId: string): Promise<void> {
  if (!source.cookieHeader) return;
  const tokens = (
    await Promise.all(
      [...parseCookies(source.cookieHeader).keys()]
        .filter((name) => name.includes('_multi-'))
        .map((name) => source.getSignedCookie(name)),
    )
  ).filter((token): token is string => z.string().safeParse(token).success);
  if (tokens.length === 0) return;
  const deviceSessions = await source.findSessions(tokens);
  const conflict = deviceSessions.some((entry) => entry !== null && entry.session.expiresAt > new Date() && entry.user.id === userId);
  if (!conflict) return;
  throw APIError.from('CONFLICT', {
    code: DEVICE_SESSION_CONFLICT_CODE,
    message: 'This account is already signed in on this device.',
  });
}
