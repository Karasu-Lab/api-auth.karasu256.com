export {};

declare global {
  interface Env {
    APP_ENV: 'local' | 'preview' | 'production';
    BETTER_AUTH_URL: string;
    AUTH_UI_URL: string;
    SSO_UI_URL: string;
    ACCOUNTS_URL: string;
    ACCOUNTS_MCP_URL: string;
    API_URL: string;
    FEATURE_FLAGS_API_URL: string;
    FEATURE_FLAGS_ORIGIN: string;
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
    CLOUDFLARE_SIGN_IN_LOOKUP_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    MICROSOFT_CLIENT_ID?: string;
    MICROSOFT_CLIENT_SECRET?: string;
    E2E_MOCK_OAUTH_URL?: string;
    CLOUDFLARE_TURNSTILE_SECRET?: string;
    CDN_URL: string;
    STORAGE_ENDPOINT: string;
    STORAGE_BUCKET: string;
    STORAGE_ACCESS_KEY_ID: string;
    STORAGE_SECRET_ACCESS_KEY: string;
    STORAGE_REGION?: string;
    STORAGE_PRESIGN_TTL_SECONDS?: string;
    UPLOAD_INTENT_TTL_SECONDS?: string;
  }
}
