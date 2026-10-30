const WINDOW_MS = 60_000;
const LIMIT = 10;

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the current window resets; 0 when the request is allowed. */
  retryAfterSeconds: number;
}

const windows = new Map<string, { count: number; resetAt: number }>();

/**
 * Fixed-window rate limit for the sign-in lookup endpoint: at most 10
 * requests per minute per key (the client IP). The endpoint answers
 * account-existence questions, so it is the one place worth throttling.
 *
 * Uses the Cloudflare Rate Limiting binding when configured. When the
 * binding is absent (local development) or errors, a per-isolate in-memory
 * window takes over so the limit still applies; the binding does not report
 * the exact reset time, so its verdicts advertise the full window.
 */
export async function checkSignInLookupRateLimit(env: Env, key: string): Promise<RateLimitVerdict> {
  const binding = env.CLOUDFLARE_SIGN_IN_LOOKUP_RATE_LIMITER;
  if (binding) {
    try {
      const { success } = await binding.limit({ key });
      return { allowed: success, retryAfterSeconds: success ? 0 : WINDOW_MS / 1000 };
    } catch {
      // Fall through to the in-memory window.
    }
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
