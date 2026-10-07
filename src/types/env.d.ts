export {};

declare global {
  interface Env {
    APP_ENV: 'local' | 'preview' | 'production';
    BETTER_AUTH_URL: string;
    AUTH_UI_URL: string;
    ACCOUNTS_URL: string;
    BASE_DOMAIN?: string;
    BETTER_AUTH_SECRET: string;
    AUTH_SECRET: string;
    INTERNAL_API_SECRET: string;
    DATABASE_URL: string;
    FIREBASE_ADMIN_PROJECT_ID: string;
    FIREBASE_ADMIN_CLIENT_EMAIL: string;
    FIREBASE_ADMIN_PRIVATE_KEY: string;
    FIREBASE_AUTH_EMULATOR_HOST?: string;
    RESEND_API_KEY: string;
    RESEND_FROM_EMAIL: string;
    NEON_AUTH_BASE_URL: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    E2E_MOCK_OAUTH_URL?: string;
  }
}
