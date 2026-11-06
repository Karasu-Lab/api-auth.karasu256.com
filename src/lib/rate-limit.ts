import type { RateLimitVerdict } from '@karasu-lab/types/server';

export type { RateLimitVerdict };

const WINDOW_MS = 60_000;
const LIMIT = 10;

const windows = new Map<string, { count: number; resetAt: number }>();

export async function checkSignInLookupRateLimit(env: Env, key: string): Promise<RateLimitVerdict> {
  const binding = env.CLOUDFLARE_SIGN_IN_LOOKUP_RATE_LIMITER;
  if (binding) {
    try {
      const { success } = await binding.limit({ key });
      return { allowed: success, retryAfterSeconds: success ? 0 : WINDOW_MS / 1000 };
    } catch {}
  }

  const now = Date.now();
  const entry = windows.get(key);
  if (!entry || entry.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (entry.count >= LIMIT) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }
  entry.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}
