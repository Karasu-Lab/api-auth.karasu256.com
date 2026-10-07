import { importPKCS8, SignJWT } from 'jose';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

interface CachedToken {
  value: string;
  expiresAt: number;
}

let cachedToken: CachedToken | undefined;

/** Exchanges a service-account JWT for an OAuth access token, reusing it until shortly before expiry. */
async function getAccessToken(env: Env): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const key = await importPKCS8(env.FIREBASE_ADMIN_PRIVATE_KEY.replace(/\\n/g, '\n'), 'RS256');
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(env.FIREBASE_ADMIN_CLIENT_EMAIL)
    .setSubject(env.FIREBASE_ADMIN_CLIENT_EMAIL)
    .setAudience(TOKEN_URL)
    .setIssuedAt()
    .setExpirationTime('55m')
    .sign(key);

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!response.ok) throw new Error(`Failed to obtain a Firebase access token: ${response.status}`);

  const { access_token, expires_in } = (await response.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: access_token, expiresAt: Date.now() + expires_in * 1000 };
  return access_token;
}

/** Calls the Identity Toolkit admin API, against the Auth emulator when `FIREBASE_AUTH_EMULATOR_HOST` is set. */
async function identityToolkit<T>(env: Env, path: string, body: unknown): Promise<T> {
  const emulator = env.FIREBASE_AUTH_EMULATOR_HOST;
  const origin = emulator ? `http://${emulator}/identitytoolkit.googleapis.com` : 'https://identitytoolkit.googleapis.com';
  const token = emulator ? 'owner' : await getAccessToken(env);

  const response = await fetch(`${origin}/v1/projects/${env.FIREBASE_ADMIN_PROJECT_ID}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Firebase ${path} failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

export interface FirebaseUserInput {
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
}

/** Creates a Firebase user and returns its generated UID. */
export async function createFirebaseUser(env: Env, input: FirebaseUserInput): Promise<string> {
  const { localId } = await identityToolkit<{ localId: string }>(env, '/accounts', input);
  return localId;
}

/** Updates a Firebase user's display name and photo. */
export async function updateFirebaseUser(env: Env, uid: string, update: { displayName?: string; photoURL?: string }): Promise<void> {
  await identityToolkit(env, '/accounts:update', {
    localId: uid,
    displayName: update.displayName,
    photoUrl: update.photoURL,
  });
}

/** Deletes a Firebase user. */
export async function deleteFirebaseUser(env: Env, uid: string): Promise<void> {
  await identityToolkit(env, '/accounts:delete', { localId: uid });
}
