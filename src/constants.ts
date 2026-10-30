import { z } from 'zod';

/**
 * The configurable values that point at the Karasu Lab domains. Their
 * production values are the defaults here, so the worker needs no URL
 * configuration in its wrangler vars — only secrets are provisioned from
 * outside. An environment variable of the same name still overrides the
 * default, and the defaults branch on APP_ENV so local and preview runs
 * resolve their own domains.
 */
const PRODUCTION_DEFAULTS = {
  BETTER_AUTH_URL: 'https://api-auth.karasu256.com',
  AUTH_UI_URL: 'https://auth.karasu256.com',
  SSO_UI_URL: 'https://sso.karasu256.com',
  ACCOUNTS_URL: 'https://accounts.karasu256.com',
  BASE_DOMAIN: 'karasu256.com',
};

const PREVIEW_DEFAULTS = {
  BETTER_AUTH_URL: 'https://dev-api-auth.karasu256.com',
  AUTH_UI_URL: 'https://dev-auth.karasu256.com',
  SSO_UI_URL: 'https://dev-sso.karasu256.com',
  ACCOUNTS_URL: 'https://dev.accounts.karasu256.com',
  BASE_DOMAIN: 'karasu256.com',
};

const LOCAL_DEFAULTS = {
  BETTER_AUTH_URL: 'http://localhost:8790',
  AUTH_UI_URL: 'http://localhost:3004',
  SSO_UI_URL: 'http://localhost:3007',
  ACCOUNTS_URL: 'http://localhost:3001',
  // No BASE_DOMAIN locally: the local wrangler environment never defined
  // one, and setting it would turn on cross-subdomain cookies, whose
  // Domain attribute a localhost caller cannot send back.
};

type DomainDefaults = {
  BETTER_AUTH_URL: string;
  AUTH_UI_URL: string;
  SSO_UI_URL: string;
  ACCOUNTS_URL: string;
  BASE_DOMAIN?: string;
};

function domainEnvSchema(defaults: DomainDefaults) {
  return z.object({
    BETTER_AUTH_URL: z.url().default(defaults.BETTER_AUTH_URL),
    AUTH_UI_URL: z.url().default(defaults.AUTH_UI_URL),
    SSO_UI_URL: z.url().default(defaults.SSO_UI_URL),
    ACCOUNTS_URL: z.url().default(defaults.ACCOUNTS_URL),
    BASE_DOMAIN: defaults.BASE_DOMAIN ? z.string().default(defaults.BASE_DOMAIN) : z.string().optional(),
  });
}

/**
 * Materializes the worker's environment: every domain value the worker
 * was not explicitly given is filled in from the constants above,
 * branched on APP_ENV (local / preview / production). Called once where
 * the worker materializes its env, before any handler reads it.
 */
export function resolveEnv(raw: Env): Env {
  const defaults =
    raw.APP_ENV === 'local' ? LOCAL_DEFAULTS : raw.APP_ENV === 'preview' ? PREVIEW_DEFAULTS : PRODUCTION_DEFAULTS;
  return { ...raw, ...domainEnvSchema(defaults).parse(raw) };
}
