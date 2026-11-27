import { z } from 'zod';

const handoffSchema = z.object({
  url: z.string().url(),
  cookies: z.array(z.string().max(8192)).max(20),
  expiresAt: z.number(),
});

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (char) => char.charCodeAt(0));
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function createOAuthLinkHandoff(secret: string, url: string, cookies: string[]): Promise<string> {
  const authorizationURL = new URL(url);
  if (authorizationURL.protocol !== 'https:') throw new Error('OAuth authorization URL must use HTTPS');
  if (cookies.length > 20 || cookies.some((cookie) => cookie.length > 8192)) {
    throw new Error('OAuth link state cookies exceed the handoff limit');
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ url: authorizationURL.toString(), cookies, expiresAt: Date.now() + 5 * 60 * 1000 }),
  );
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(secret), plaintext);
  const ticket = `${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
  if (ticket.length > 16_384) throw new Error('OAuth link handoff exceeds the ticket limit');
  return ticket;
}

export async function readOAuthLinkHandoff(
  secret: string,
  ticket: string,
  now = Date.now(),
): Promise<{ url: string; cookies: string[] } | null> {
  if (ticket.length > 16_384) return null;
  const [encodedIv, encodedCiphertext, extra] = ticket.split('.');
  if (!encodedIv || !encodedCiphertext || extra) return null;

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decode(encodedIv) },
      await encryptionKey(secret),
      decode(encodedCiphertext),
    );
    const parsed = handoffSchema.safeParse(JSON.parse(new TextDecoder().decode(plaintext)));
    if (!parsed.success || parsed.data.expiresAt < now || parsed.data.cookies.some((cookie) => cookie.length > 8192)) return null;
    if (new URL(parsed.data.url).protocol !== 'https:') return null;
    return { url: parsed.data.url, cookies: parsed.data.cookies };
  } catch {
    return null;
  }
}
