import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { storageEnv } from './storage';

const intentSchema = z.object({
  userId: z.string(),
  clientId: z.string(),
  path: z.string(),
  sha256: z.string(),
  contentType: z.string(),
  size: z.number(),
  exp: z.number(),
});

export type UploadIntent = Omit<z.infer<typeof intentSchema>, 'exp'>;

function sign(env: Env, payload: string): string {
  return createHmac('sha256', env.BETTER_AUTH_SECRET).update(payload).digest('base64url');
}

export function signUploadIntent(env: Env, intent: UploadIntent): string {
  const exp = Date.now() + storageEnv(env).UPLOAD_INTENT_TTL_SECONDS * 1000;
  const payload = Buffer.from(JSON.stringify({ ...intent, exp })).toString('base64url');
  return `${payload}.${sign(env, payload)}`;
}

export function verifyUploadIntent(env: Env, token: string, userId: string, clientId: string): UploadIntent | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(env, payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  const parsed = intentSchema.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
  if (!parsed.success) return null;
  const { exp, ...intent } = parsed.data;
  if (exp < Date.now() || intent.userId !== userId || intent.clientId !== clientId) return null;
  return intent;
}
