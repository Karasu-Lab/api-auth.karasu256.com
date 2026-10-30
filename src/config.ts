const ANDROID_ORIGINS = [
  'android:apk-key-hash:bfKpYRlXNOkeRYJCoMaSQi9kSA6IKX4TYjuCHg35mws',
  'android:apk-key-hash:uo795W5PTsfIrzRiahbhbBMqqve55APHGJ3H55qPlDk',
];

export interface AuthConfig {
  webauthn: { rpId: string; rpName: string; expectedOrigins: string[] };
  trustedOrigins: string[];
  /** Hostnames a Turnstile challenge may run on for this environment (the auth and sso sign-in pages). */
  turnstileHostnames: string[];
}

const CONFIGS: Record<Env['APP_ENV'], AuthConfig> = {
  local: {
    webauthn: {
      rpId: 'karasu256.com',
      rpName: 'Karasu Lab',
      expectedOrigins: ['https://local-accounts.karasu256.com', 'https://local-auth.karasu256.com', ...ANDROID_ORIGINS],
    },
    turnstileHostnames: ['local-auth.karasu256.com', 'local-sso.karasu256.com'],
    trustedOrigins: [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
      'http://localhost:3004',
      'http://localhost:3007',
      'http://localhost:8790',
      'https://local.karasu256.com',
      'https://local-accounts.karasu256.com',
      'https://local-qr.karasu256.com',
      'https://local-auth.karasu256.com',
      'https://local-sso.karasu256.com',
      'https://local-api-auth.karasu256.com',
    ],
  },
  preview: {
    webauthn: {
      rpId: 'karasu256.com',
      rpName: 'Karasu Lab',
      expectedOrigins: ['https://dev.accounts.karasu256.com', 'https://dev-auth.karasu256.com', 'https://dev.karasu256.com', ...ANDROID_ORIGINS],
    },
    turnstileHostnames: ['dev-auth.karasu256.com', 'dev-sso.karasu256.com'],
    trustedOrigins: [
      'https://dev.accounts.karasu256.com',
      'https://dev-auth.karasu256.com',
      'https://dev-sso.karasu256.com',
      'https://dev-api-auth.karasu256.com',
      'https://dev.karasu256.com',
      'https://dev.qr.karasu256.com',
    ],
  },
  production: {
    webauthn: {
      rpId: 'karasu256.com',
      rpName: 'Karasu Lab',
      expectedOrigins: ['https://accounts.karasu256.com', 'https://auth.karasu256.com', 'https://karasu256.com', ...ANDROID_ORIGINS],
    },
    turnstileHostnames: ['auth.karasu256.com', 'sso.karasu256.com'],
    trustedOrigins: [
      'https://accounts.karasu256.com',
      'https://auth.karasu256.com',
      'https://sso.karasu256.com',
      'https://api-auth.karasu256.com',
      'https://karasu256.com',
      'https://qr.karasu256.com',
    ],
  },
};

/**
 * Returns the webauthn and trusted-origin tables for the worker's `APP_ENV`.
 * Android passkeys report their origin as `android:apk-key-hash:...`, so those
 * entries belong in `expectedOrigins`, not `trustedOrigins`.
 */
export function getAuthConfig(env: Env): AuthConfig {
  return CONFIGS[env.APP_ENV];
}
