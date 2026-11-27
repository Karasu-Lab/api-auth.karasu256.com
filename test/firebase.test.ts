import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFirebaseUser } from '../src/lib/firebase';

async function generatePrivateKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, [
    'sign',
    'verify',
  ]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  let binary = '';
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const base64 = (token.split('.')[1] as string).replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(base64)) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Firebase service account key', () => {
  it('signs the token request and calls Identity Toolkit with the values from the JSON key', async () => {
    const serviceAccountKey = JSON.stringify({
      type: 'service_account',
      project_id: 'demo-project',
      client_email: 'firebase-adminsdk@demo-project.iam.gserviceaccount.com',
      private_key: await generatePrivateKeyPem(),
    });
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        calls.push({ url, init });
        if (url === 'https://oauth2.googleapis.com/token') {
          return Response.json({ access_token: 'access-token', expires_in: 3600 });
        }
        if (url === 'https://identitytoolkit.googleapis.com/v1/projects/demo-project/accounts') {
          return Response.json({ localId: 'uid-123' });
        }
        return new Response('unexpected', { status: 500 });
      }),
    );

    const env = { FIREBASE_SERVICE_ACCOUNT_KEY: serviceAccountKey } as unknown as Env;
    await expect(createFirebaseUser(env, { email: 'user@example.com' })).resolves.toBe('uid-123');

    const tokenCall = calls.find((call) => call.url === 'https://oauth2.googleapis.com/token');
    const assertion = new URLSearchParams(tokenCall?.init?.body as string).get('assertion') as string;
    const payload = decodeJwtPayload(assertion);
    expect(payload.iss).toBe('firebase-adminsdk@demo-project.iam.gserviceaccount.com');
    expect(payload.sub).toBe('firebase-adminsdk@demo-project.iam.gserviceaccount.com');

    const identityCall = calls.find((call) => call.url.includes('identitytoolkit.googleapis.com'));
    expect(new Headers(identityCall?.init?.headers).get('authorization')).toBe('Bearer access-token');
  });

  it('rejects a key that is not JSON', async () => {
    const env = { FIREBASE_SERVICE_ACCOUNT_KEY: 'not-json' } as unknown as Env;
    await expect(createFirebaseUser(env, { email: 'user@example.com' })).rejects.toThrow('FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON.');
  });

  it('rejects a JSON value that is not a service account key', async () => {
    const env = { FIREBASE_SERVICE_ACCOUNT_KEY: '{"project_id":"demo-project"}' } as unknown as Env;
    await expect(createFirebaseUser(env, { email: 'user@example.com' })).rejects.toThrow('FIREBASE_SERVICE_ACCOUNT_KEY is not a service account key');
  });
});
