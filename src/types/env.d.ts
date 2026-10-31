export {};

declare global {
  interface Env {
    APP_ENV: 'local' | 'preview' | 'production';
    BETTER_AUTH_URL: string;
    AUTH_UI_URL: string;
    SSO_UI_URL: string;
    ACCOUNTS_URL: string;
    /** Base URL of api.karasu256.com, which owns the permission registry; defaulted by src/constants.ts per APP_ENV. */
    API_URL: string;
    /** Defaulted by src/constants.ts in production and preview; intentionally unset locally, where cross-subdomain cookies stay off. */
    BASE_DOMAIN?: string;
    BETTER_AUTH_SECRET: string;
    AUTH_SECRET: string;
    INTERNAL_API_SECRET: string;
    DATABASE_URL: string;
    GOOGLE_CLOUD_PROJECT_ID: string;
    FIREBASE_ADMIN_CLIENT_EMAIL: string;
    FIREBASE_ADMIN_PRIVATE_KEY: string;
    FIREBASE_AUTH_EMULATOR_HOST?: string;
    RESEND_API_KEY: string;
    RESEND_FROM_EMAIL: string;
    NEON_AUTH_BASE_URL: string;
    /** Cloudflare Rate Limiting binding for the sign-in lookup endpoint; absent where the binding is not configured, in which case an in-memory fallback applies. */
    CLOUDFLARE_SIGN_IN_LOOKUP_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    E2E_MOCK_OAUTH_URL?: string;
    /** Turnstile widget secret for bot verification of the credential endpoints; verification stays off while unset. */
    CLOUDFLARE_TURNSTILE_SECRET?: string;
  }
}
