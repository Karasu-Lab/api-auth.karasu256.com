import { authConfigSchema, type AuthConfig } from '@karasu-lab/types/server';
import { z } from 'zod';

export type { AuthConfig };

function parseStringArray(name: string, raw: string | undefined): string[] {
  if (!raw) throw new Error(`${name} is not set; it must be a JSON array of strings`);
  try {
    return z.array(z.string().min(1)).parse(JSON.parse(raw));
  } catch {
    throw new Error(`${name} must be a JSON array of non-empty strings`);
  }
}

/**
 * Builds the auth configuration from the worker's variables. Every list of
 * allowed origins comes from a variable holding a JSON array, so nothing
 * differs per environment in code: each GitHub environment (or the local
 * `.dev.vars`) supplies its own values.
 */
export function getAuthConfig(env: Env): AuthConfig {
  return authConfigSchema.parse({
    webauthn: {
      rpId: 'karasu256.com',
      rpName: 'Karasu Lab',
      expectedOrigins: parseStringArray('WEBAUTHN_EXPECTED_ORIGINS', env.WEBAUTHN_EXPECTED_ORIGINS),
    },
    trustedOrigins: parseStringArray('TRUSTED_ORIGINS', env.TRUSTED_ORIGINS),
    turnstileHostnames: parseStringArray('TURNSTILE_HOSTNAMES', env.TURNSTILE_HOSTNAMES),
    batchWorks: { maxConcurrency: z.coerce.number().int().positive().parse(env.BATCH_WORKS_MAX_CONCURRENCY) },
  });
}
