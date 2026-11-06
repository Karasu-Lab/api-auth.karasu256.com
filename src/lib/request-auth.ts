import { waitUntil } from 'cloudflare:workers';
import { createDb } from '@karasu-lab/db/create-db';
import { z } from 'zod';
import { createAuth, type Auth } from './auth';

export async function withAuth<T>(env: Env, fn: (auth: Auth) => Promise<T>): Promise<T> {
  const db = createDb(env.DATABASE_URL);
  try {
    return await fn(createAuth(env, db));
  } finally {
    waitUntil(db.$client.end());
  }
}

const textBodySchema = z.string();

export function toHandlerRequest(request: Request, body: unknown): Request {
  if (body === undefined) return request;
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  const textBody = textBodySchema.safeParse(body);
  return new Request(request.url, {
    method: request.method,
    headers,
    body: textBody.success ? textBody.data : JSON.stringify(body),
  });
}
