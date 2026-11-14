import { z } from 'zod';

const domainEnvSchema = z.object({
  BETTER_AUTH_URL: z.url(),
  AUTH_UI_URL: z.url(),
  SSO_UI_URL: z.url(),
  ACCOUNTS_URL: z.url(),
  MCP_URL: z.url(),
  API_URL: z.url(),
  FEATURE_FLAGS_API_URL: z.url(),
  FEATURE_FLAGS_ORIGIN: z.url(),
  BASE_DOMAIN: z.string().optional(),
  REDIS_URL: z.string().optional(),
});

export function resolveEnv(raw: Env): Env {
  return { ...raw, ...domainEnvSchema.parse(raw) };
}
