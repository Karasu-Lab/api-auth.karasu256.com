import type { RateLimitVerdict } from '@karasu-lab/types/server';

const WINDOW_SECONDS = 60;
const LIMIT = 30;

export async function checkMinecraftStatusRateLimit(env: Env, key: string): Promise<RateLimitVerdict> {
  const now = Date.now();
  const window = Math.floor(now / (WINDOW_SECONDS * 1000));
  const kvKey = `minecraft-status:${key}:${window}`;
  const used = Number(await env.MINECRAFT_STATUS_RATE_LIMIT_KV.get(kvKey)) || 0;
  if (used >= LIMIT) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(((window + 1) * WINDOW_SECONDS * 1000 - now) / 1000)) };
  }
  await env.MINECRAFT_STATUS_RATE_LIMIT_KV.put(kvKey, String(used + 1), { expirationTtl: WINDOW_SECONDS });
  return { allowed: true, retryAfterSeconds: 0 };
}
