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

function parsePositiveInteger(name: string, raw: string | undefined): number {
  const value = Number(raw);
  if (!raw || !Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function parseOptionalStringArray(name: string, raw: string | undefined): string[] {
  return raw ? parseStringArray(name, raw) : [];
}

export function getAuthConfig(env: Env): AuthConfig {
  return authConfigSchema.parse({
    webauthn: {
      rpId: 'karasu256.com',
      rpName: 'Karasu Lab',
      expectedOrigins: parseStringArray('WEBAUTHN_EXPECTED_ORIGINS', env.WEBAUTHN_EXPECTED_ORIGINS),
    },
    trustedOrigins: parseStringArray('TRUSTED_ORIGINS', env.TRUSTED_ORIGINS),
    turnstileHostnames: parseOptionalStringArray('TURNSTILE_HOSTNAMES', env.TURNSTILE_HOSTNAMES),
    batchWorks: { maxConcurrency: parsePositiveInteger('BATCH_WORKS_MAX_CONCURRENCY', env.BATCH_WORKS_MAX_CONCURRENCY) },
  });
}
