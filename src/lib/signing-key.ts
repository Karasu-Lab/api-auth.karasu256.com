import type { AuthContext } from '@better-auth/core';
import { decryptOAuthToken, setTokenUtil } from 'better-auth/oauth2';
import { signingKeyAuthorizations } from '@karasu-lab/db/schema';
import type { Db } from '@karasu-lab/db/create-db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Auth } from './auth';

const GITHUB_API_URL = 'https://api.github.com';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

export interface SshKeyPair {
  publicKey: string;
  privateKey: string;
  fingerprint: string;
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function sshString(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  out.set(uint32(bytes.length), 0);
  out.set(bytes, 4);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function buildOpenSshPublicKeyBlob(rawPublicKey: Uint8Array): Uint8Array {
  return concatBytes([sshString(new TextEncoder().encode('ssh-ed25519')), sshString(rawPublicKey)]);
}

export function formatOpenSshPublicKey(rawPublicKey: Uint8Array): string {
  return `ssh-ed25519 ${base64Encode(buildOpenSshPublicKeyBlob(rawPublicKey))}`;
}

export async function computeSshFingerprint(rawPublicKey: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buildOpenSshPublicKeyBlob(rawPublicKey) as BufferSource);
  return `SHA256:${base64Encode(new Uint8Array(digest)).replace(/=+$/, '')}`;
}

export function formatOpenSshPrivateKey(seed: Uint8Array, rawPublicKey: Uint8Array): string {
  const check = crypto.getRandomValues(new Uint32Array(1))[0]!;
  const privateMaterial = concatBytes([seed, rawPublicKey]);
  let privateBlock = concatBytes([
    uint32(check),
    uint32(check),
    sshString(new TextEncoder().encode('ssh-ed25519')),
    sshString(rawPublicKey),
    sshString(privateMaterial),
    sshString(new Uint8Array(0)),
  ]);
  const paddingLength = (8 - (privateBlock.length % 8)) % 8;
  if (paddingLength > 0) {
    const padding = Uint8Array.from({ length: paddingLength }, (_, index) => index + 1);
    privateBlock = concatBytes([privateBlock, padding]);
  }
  const body = concatBytes([
    new TextEncoder().encode('openssh-key-v1\0'),
    sshString(new TextEncoder().encode('none')),
    sshString(new TextEncoder().encode('none')),
    sshString(new Uint8Array(0)),
    uint32(1),
    sshString(buildOpenSshPublicKeyBlob(rawPublicKey)),
    sshString(privateBlock),
  ]);
  const encoded = base64Encode(body);
  const lines = encoded.match(/.{1,70}/g) ?? [];
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

export async function generateSshKeyPair(): Promise<SshKeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const rawPublicKey = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const seed = pkcs8.slice(pkcs8.length - 32);
  return {
    publicKey: formatOpenSshPublicKey(rawPublicKey),
    privateKey: formatOpenSshPrivateKey(seed, rawPublicKey),
    fingerprint: await computeSshFingerprint(rawPublicKey),
  };
}

const githubSigningKeySchema = z.object({
  id: z.number(),
  key: z.string(),
  title: z.string(),
  created_at: z.string(),
});

export type GithubSigningKey = z.infer<typeof githubSigningKeySchema>;

async function githubKeyFetch(token: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${GITHUB_API_URL}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'karasu-lab-api-auth',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
}

export async function registerGithubSigningKey(
  token: string,
  title: string,
  publicKey: string
): Promise<GithubSigningKey | null> {
  const response = await githubKeyFetch(token, '/user/ssh_signing_keys', {
    method: 'POST',
    body: JSON.stringify({ title, key: publicKey }),
  });
  if (!response.ok) return null;
  const parsed = githubSigningKeySchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

export async function getGithubSigningKey(token: string, keyId: number): Promise<GithubSigningKey | null> {
  const response = await githubKeyFetch(token, `/user/ssh_signing_keys/${keyId}`);
  if (!response.ok) return null;
  const parsed = githubSigningKeySchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

export async function deleteGithubSigningKey(token: string, keyId: number): Promise<boolean> {
  const response = await githubKeyFetch(token, `/user/ssh_signing_keys/${keyId}`, { method: 'DELETE' });
  return response.ok || response.status === 404;
}

const githubTokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  refresh_token_expires_in: z.number().optional(),
  scope: z.string().optional(),
});

export async function exchangeSigningKeyAuthorizationCode(
  env: Env,
  code: string,
  redirectUri: string
): Promise<z.infer<typeof githubTokenResponseSchema> | null> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return null;
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) return null;
  const parsed = githubTokenResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

async function refreshSigningKeyTokens(
  env: Env,
  refreshToken: string
): Promise<z.infer<typeof githubTokenResponseSchema> | null> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return null;
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) return null;
  const parsed = githubTokenResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

export async function storeSigningKeyAuthorization(
  auth: Auth,
  db: Db,
  userId: string,
  tokens: z.infer<typeof githubTokenResponseSchema>
): Promise<void> {
  const ctx = (await auth.$context) as unknown as AuthContext;
  const now = Date.now();
  const values = {
    accessToken: (await setTokenUtil(tokens.access_token, ctx)) ?? null,
    refreshToken: tokens.refresh_token ? ((await setTokenUtil(tokens.refresh_token, ctx)) ?? null) : null,
    accessTokenExpiresAt: tokens.expires_in ? new Date(now + tokens.expires_in * 1000) : null,
    refreshTokenExpiresAt: tokens.refresh_token_expires_in
      ? new Date(now + tokens.refresh_token_expires_in * 1000)
      : null,
    scope: tokens.scope ?? 'admin:ssh_signing_key',
  };
  await db
    .insert(signingKeyAuthorizations)
    .values({ id: crypto.randomUUID(), userId, ...values })
    .onConflictDoUpdate({ target: signingKeyAuthorizations.userId, set: values });
}

export async function getSigningKeyAccessToken(env: Env, auth: Auth, db: Db, userId: string): Promise<string | null> {
  const rows = await db.select().from(signingKeyAuthorizations).where(eq(signingKeyAuthorizations.userId, userId)).limit(1);
  const row = rows[0];
  if (!row?.accessToken) return null;
  const ctx = (await auth.$context) as unknown as AuthContext;
  const accessToken = await Promise.resolve(decryptOAuthToken(row.accessToken, ctx)).catch(() => null);
  if (!accessToken) return null;
  const expired = row.accessTokenExpiresAt ? row.accessTokenExpiresAt.getTime() <= Date.now() + 30_000 : false;
  if (!expired || !row.refreshToken) return accessToken;
  const refreshToken = await Promise.resolve(decryptOAuthToken(row.refreshToken, ctx)).catch(() => null);
  if (!refreshToken) return accessToken;
  const refreshed = await refreshSigningKeyTokens(env, refreshToken).catch(() => null);
  if (!refreshed) return accessToken;
  await storeSigningKeyAuthorization(auth, db, userId, {
    ...refreshed,
    refresh_token: refreshed.refresh_token ?? refreshToken,
  }).catch(() => undefined);
  return refreshed.access_token;
}
