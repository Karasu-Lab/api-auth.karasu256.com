import { z } from 'zod';

const STATE_TTL_MS = 10 * 60 * 1000;

export const linkStatePayloadSchema = z.object({
  kind: z.string().min(1),
  userId: z.string().min(1),
  organizationId: z.string().min(1),
  returnTo: z.string().min(1),
  exp: z.number(),
});

export type LinkStatePayload = z.infer<typeof linkStatePayloadSchema>;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function createLinkState(
  secret: string,
  payload: Omit<LinkStatePayload, 'exp'>
): Promise<string> {
  const body = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ ...payload, exp: Date.now() + STATE_TTL_MS }))
  );
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyLinkState(secret: string, state: string): Promise<LinkStatePayload | null> {
  const [body, signature] = state.split('.');
  if (!body || !signature) return null;
  const valid = await crypto.subtle
    .verify('HMAC', await hmacKey(secret), base64UrlDecode(signature), new TextEncoder().encode(body))
    .catch(() => false);
  if (!valid) return null;
  try {
    const parsed = linkStatePayloadSchema.safeParse(JSON.parse(new TextDecoder().decode(base64UrlDecode(body))));
    if (!parsed.success || parsed.data.exp <= Date.now()) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
