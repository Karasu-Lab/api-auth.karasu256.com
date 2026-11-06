import { z } from 'zod';

const PRODUCTION_DEFAULTS = {
  BETTER_AUTH_URL: 'https://api-auth.karasu256.com',
  AUTH_UI_URL: 'https://auth.karasu256.com',
  SSO_UI_URL: 'https://sso.karasu256.com',
  ACCOUNTS_URL: 'https://accounts.karasu256.com',
  MCP_URL: 'https://mcp.karasu256.com/mcp',
  API_URL: 'https://api.karasu256.com',
  FEATURE_FLAGS_API_URL: 'https://flags.karasu256.com',
  FEATURE_FLAGS_ORIGIN: 'https://api-auth.karasu256.com',
  BASE_DOMAIN: 'karasu256.com',
};

const PREVIEW_DEFAULTS = {
  BETTER_AUTH_URL: 'https://dev-api-auth.karasu256.com',
  AUTH_UI_URL: 'https://dev-auth.karasu256.com',
  SSO_UI_URL: 'https://dev-sso.karasu256.com',
  ACCOUNTS_URL: 'https://dev.accounts.karasu256.com',
  MCP_URL: 'https://dev.mcp.karasu256.com/mcp',
  API_URL: 'https://dev-api.karasu256.com',
  FEATURE_FLAGS_API_URL: 'https://dev-flags.karasu256.com',
  FEATURE_FLAGS_ORIGIN: 'https://dev-api-auth.karasu256.com',
  BASE_DOMAIN: 'karasu256.com',
};

const LOCAL_DEFAULTS = {
  BETTER_AUTH_URL: 'http://localhost:8790',
  AUTH_UI_URL: 'http://localhost:3004',
  SSO_UI_URL: 'http://localhost:3007',
  ACCOUNTS_URL: 'http://localhost:3001',
  MCP_URL: 'http://localhost:8791/mcp',
  API_URL: 'http://localhost:8789',
  FEATURE_FLAGS_API_URL: 'https://dev-flags.karasu256.com',
  FEATURE_FLAGS_ORIGIN: 'https://dev-api-auth.karasu256.com',
};

type DomainDefaults = {
  BETTER_AUTH_URL: string;
  AUTH_UI_URL: string;
  SSO_UI_URL: string;
  ACCOUNTS_URL: string;
  MCP_URL: string;
  API_URL: string;
  FEATURE_FLAGS_API_URL: string;
  FEATURE_FLAGS_ORIGIN: string;
  BASE_DOMAIN?: string;
};

function domainEnvSchema(defaults: DomainDefaults) {
  return z.object({
    BETTER_AUTH_URL: z.url().default(defaults.BETTER_AUTH_URL),
    AUTH_UI_URL: z.url().default(defaults.AUTH_UI_URL),
    SSO_UI_URL: z.url().default(defaults.SSO_UI_URL),
    ACCOUNTS_URL: z.url().default(defaults.ACCOUNTS_URL),
    MCP_URL: z.url().default(defaults.MCP_URL),
    API_URL: z.url().default(defaults.API_URL),
    FEATURE_FLAGS_API_URL: z.url().default(defaults.FEATURE_FLAGS_API_URL),
    FEATURE_FLAGS_ORIGIN: z.url().default(defaults.FEATURE_FLAGS_ORIGIN),
    BASE_DOMAIN: defaults.BASE_DOMAIN ? z.string().default(defaults.BASE_DOMAIN) : z.string().optional(),
  });
}

export function resolveEnv(raw: Env): Env {
  const defaults =
    raw.APP_ENV === 'local' ? LOCAL_DEFAULTS : raw.APP_ENV === 'preview' ? PREVIEW_DEFAULTS : PRODUCTION_DEFAULTS;
  return { ...raw, ...domainEnvSchema(defaults).parse(raw) };
}
