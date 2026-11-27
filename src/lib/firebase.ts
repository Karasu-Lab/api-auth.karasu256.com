import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import type { FirebaseUserInput } from '@karasu-lab/types/server';

export type { FirebaseUserInput };

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

const serviceAccountSchema = z.object({
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
});

type ServiceAccount = z.infer<typeof serviceAccountSchema>;

let cachedServiceAccount: { raw: string; account: ServiceAccount } | undefined;

function serviceAccount(env: Env): ServiceAccount {
  const raw = env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (cachedServiceAccount?.raw === raw) return cachedServiceAccount.account;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON.');
  }
  const result = serviceAccountSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY is not a service account key: project_id, client_email, and private_key are required.');
  }
  cachedServiceAccount = { raw, account: result.data };
  return result.data;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

let cachedToken: CachedToken | undefined;

async function getAccessToken(env: Env, account: ServiceAccount): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const key = await importPKCS8(account.private_key.replace(/\\n/g, '\n'), 'RS256');
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(account.client_email)
    .setSubject(account.client_email)
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

async function identityToolkit<T>(env: Env, path: string, body: unknown): Promise<T> {
  const account = serviceAccount(env);
  const emulator = env.FIREBASE_AUTH_EMULATOR_HOST;
  const origin = emulator ? `http://${emulator}/identitytoolkit.googleapis.com` : 'https://identitytoolkit.googleapis.com';
  const token = emulator ? 'owner' : await getAccessToken(env, account);

  const response = await fetch(`${origin}/v1/projects/${account.project_id}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Firebase ${path} failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

export interface FirebaseProviderUserInfo {
  providerId: string;
  rawId: string;
}

export async function createFirebaseUser(
  env: Env,
  input: FirebaseUserInput & { providerUserInfo?: FirebaseProviderUserInfo[] },
): Promise<string> {
  const { localId } = await identityToolkit<{ localId: string }>(env, '/accounts', input);
  return localId;
}

export async function findFirebaseUidByEmail(env: Env, email: string): Promise<string | null> {
  const { users } = await identityToolkit<{ users?: { localId: string }[] }>(env, '/accounts:lookup', { email: [email] });
  return users?.[0]?.localId ?? null;
}

export async function updateFirebaseUser(
  env: Env,
  uid: string,
  update: { displayName?: string; photoURL?: string; providerUserInfo?: FirebaseProviderUserInfo[] },
): Promise<void> {
  await identityToolkit(env, '/accounts:update', {
    localId: uid,
    displayName: update.displayName,
    photoUrl: update.photoURL,
    providerUserInfo: update.providerUserInfo,
  });
}

export async function deleteFirebaseUser(env: Env, uid: string): Promise<void> {
  await identityToolkit(env, '/accounts:delete', { localId: uid });
}
