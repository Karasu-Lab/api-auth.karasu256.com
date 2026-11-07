import { createDb } from '@karasu-lab/db/create-db';
import type { Db } from '@karasu-lab/db/create-db';
import { userSigningKeys, type UserSigningKey } from '@karasu-lab/db/schema';
import { waitUntil } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  generateSigningKeyRequestSchema,
  renameSigningKeyRequestSchema,
  setSigningKeyEnabledRequestSchema,
  type SigningKeyStatusResponse,
} from '@karasu-lab/types/shared';
import { BadRequestError, HttpError, NotFoundError, UnauthorizedError } from '@karasu-lab/types/server';
import type { Auth } from '../lib/auth';
import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { withAuth } from '../lib/request-auth';
import {
  deleteGithubSigningKey,
  encryptSigningKeyPrivateKey,
  generateSshKeyPair,
  getGithubSigningKey,
  getSigningKeyAccessToken,
  registerGithubSigningKey,
} from '../lib/signing-key';
import { resolveSessionUserId } from '../lib/tenant';

const sessionBodySchema = z.object({
  sessionId: z.string().min(1),
});

const createBodySchema = sessionBodySchema.extend(generateSigningKeyRequestSchema.shape);
const renameBodySchema = sessionBodySchema.extend(renameSigningKeyRequestSchema.shape);
const enabledBodySchema = sessionBodySchema.extend(setSigningKeyEnabledRequestSchema.shape);

async function statusResponse(env: Env, auth: Auth, db: Db, userId: string, row: UserSigningKey): Promise<SigningKeyStatusResponse> {
  let registered = row.enabled && row.githubKeyId !== null;
  let name = row.name;
  if (row.githubKeyId !== null) {
    const token = await getSigningKeyAccessToken(env, auth, db, userId);
    if (token) {
      const githubKey = await getGithubSigningKey(token, row.githubKeyId);
      registered = githubKey !== null;
      if (githubKey) name = githubKey.title;
    }
  }
  return {
    id: row.id,
    publicKeyId: row.githubKeyId !== null ? String(row.githubKeyId) : row.id,
    name,
    enabled: row.enabled,
    registeredOnGitHub: registered,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function requireKeyToken(env: Env, auth: Auth, db: Db, userId: string): Promise<string> {
  const token = await getSigningKeyAccessToken(env, auth, db, userId);
  if (!token) throw new HttpError(403, { error: 'signing_key_authorization_required' });
  return token;
}

async function findOwnKey(db: Db, userId: string): Promise<UserSigningKey | null> {
  const rows = await db.select().from(userSigningKeys).where(eq(userSigningKeys.userId, userId)).limit(1);
  return rows[0] ?? null;
}

async function requireOwnKey(db: Db, userId: string, keyId: string): Promise<UserSigningKey> {
  const rows = await db
    .select()
    .from(userSigningKeys)
    .where(and(eq(userSigningKeys.userId, userId), eq(userSigningKeys.id, keyId)))
    .limit(1);
  if (!rows[0]) throw new NotFoundError();
  return rows[0];
}

function keyIdFromPath(pathname: string, suffix: string): string | null {
  const prefix = '/api/signing-keys/';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  const id = pathname.slice(prefix.length, pathname.length - suffix.length);
  return id.length > 0 && !id.includes('/') ? id : null;
}

export class CreateSigningKeyDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname === '/api/signing-keys' && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    const { env } = this.context;
    const parsed = createBodySchema.safeParse(this.context.body);
    if (!parsed.success) throw new BadRequestError();
    const { sessionId, name } = parsed.data;

    const db = createDb(env.DATABASE_URL);
    try {
      const payload = await withAuth(env, async (auth) => {
        const userId = await resolveSessionUserId(db, auth, sessionId);
        if (!userId) throw new UnauthorizedError();
        const existing = await findOwnKey(db, userId);
        if (existing) {
          const status = await statusResponse(env, auth, db, userId, existing);
          return { ...status, publicKey: existing.publicKey };
        }
        const token = await requireKeyToken(env, auth, db, userId);
        const pair = await generateSshKeyPair();
        const registered = await registerGithubSigningKey(token, name, pair.publicKey);
        if (!registered) throw new HttpError(502, { error: 'github_signing_key_registration_failed' });
        const inserted = await db
          .insert(userSigningKeys)
          .values({
            userId,
            name,
            publicKey: pair.publicKey,
            encryptedPrivateKey: await encryptSigningKeyPrivateKey(auth, pair.privateKey),
            publicKeyFingerprint: pair.fingerprint,
            githubKeyId: registered.id,
            enabled: true,
          })
          .returning();
        const status = await statusResponse(env, auth, db, userId, inserted[0]!);
        return { ...status, publicKey: pair.publicKey, privateKey: pair.privateKey };
      });
      return Response.json(payload);
    } finally {
      waitUntil(db.$client.end());
    }
  }
}

export class SigningKeyStatusDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname === '/api/signing-keys/status' && this.context.request.method === 'GET';
  }

  async handle(): Promise<Response> {
    const { env, request } = this.context;
    const query = new URL(request.url).searchParams;
    const parsed = z
      .object({
        sessionId: z.string().min(1),
        publicKeyId: z.string().min(1),
      })
      .safeParse({
        sessionId: query.get('sessionId'),
        publicKeyId: query.get('publicKeyId'),
      });
    if (!parsed.success) throw new BadRequestError();
    const { sessionId, publicKeyId } = parsed.data;

    const db = createDb(env.DATABASE_URL);
    try {
      const payload = await withAuth(env, async (auth) => {
        const userId = await resolveSessionUserId(db, auth, sessionId);
        if (!userId) throw new UnauthorizedError();
        const own = await findOwnKey(db, userId);
        if (!own) throw new NotFoundError();
        if (own.id !== publicKeyId && String(own.githubKeyId) !== publicKeyId) throw new NotFoundError();
        return statusResponse(env, auth, db, userId, own);
      });
      return Response.json(payload);
    } finally {
      waitUntil(db.$client.end());
    }
  }
}

export class RotateSigningKeyDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return keyIdFromPath(this.context.pathname, '/rotate') !== null && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    const { env } = this.context;
    const keyId = keyIdFromPath(this.context.pathname, '/rotate')!;
    const parsed = sessionBodySchema.safeParse(this.context.body);
    if (!parsed.success) throw new BadRequestError();
    const { sessionId } = parsed.data;

    const db = createDb(env.DATABASE_URL);
    try {
      const payload = await withAuth(env, async (auth) => {
        const userId = await resolveSessionUserId(db, auth, sessionId);
        if (!userId) throw new UnauthorizedError();
        const row = await requireOwnKey(db, userId, keyId);
        const token = await requireKeyToken(env, auth, db, userId);
        const pair = await generateSshKeyPair();
        const registered = await registerGithubSigningKey(token, row.name, pair.publicKey);
        if (!registered) throw new HttpError(502, { error: 'github_signing_key_registration_failed' });
        if (row.githubKeyId !== null) await deleteGithubSigningKey(token, row.githubKeyId);
        const updated = await db
          .update(userSigningKeys)
          .set({
            publicKey: pair.publicKey,
            encryptedPrivateKey: await encryptSigningKeyPrivateKey(auth, pair.privateKey),
            publicKeyFingerprint: pair.fingerprint,
            githubKeyId: registered.id,
            enabled: true,
          })
          .where(eq(userSigningKeys.id, row.id))
          .returning();
        const status = await statusResponse(env, auth, db, userId, updated[0]!);
        return { ...status, publicKey: pair.publicKey, privateKey: pair.privateKey };
      });
      return Response.json(payload);
    } finally {
      waitUntil(db.$client.end());
    }
  }
}

export class RenameSigningKeyDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return keyIdFromPath(this.context.pathname, '/rename') !== null && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    const { env } = this.context;
    const keyId = keyIdFromPath(this.context.pathname, '/rename')!;
    const parsed = renameBodySchema.safeParse(this.context.body);
    if (!parsed.success) throw new BadRequestError();
    const { sessionId, name } = parsed.data;

    const db = createDb(env.DATABASE_URL);
    try {
      const payload = await withAuth(env, async (auth) => {
        const userId = await resolveSessionUserId(db, auth, sessionId);
        if (!userId) throw new UnauthorizedError();
        const row = await requireOwnKey(db, userId, keyId);
        let githubKeyId = row.githubKeyId;
        if (row.githubKeyId !== null) {
          const token = await requireKeyToken(env, auth, db, userId);
          const registered = await registerGithubSigningKey(token, name, row.publicKey);
          if (!registered) throw new HttpError(502, { error: 'github_signing_key_registration_failed' });
          await deleteGithubSigningKey(token, row.githubKeyId);
          githubKeyId = registered.id;
        }
        const updated = await db.update(userSigningKeys).set({ name, githubKeyId }).where(eq(userSigningKeys.id, row.id)).returning();
        return statusResponse(env, auth, db, userId, updated[0]!);
      });
      return Response.json(payload);
    } finally {
      waitUntil(db.$client.end());
    }
  }
}

export class SetSigningKeyEnabledDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return keyIdFromPath(this.context.pathname, '/enabled') !== null && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    const { env } = this.context;
    const keyId = keyIdFromPath(this.context.pathname, '/enabled')!;
    const parsed = enabledBodySchema.safeParse(this.context.body);
    if (!parsed.success) throw new BadRequestError();
    const { sessionId, enabled } = parsed.data;

    const db = createDb(env.DATABASE_URL);
    try {
      const payload = await withAuth(env, async (auth) => {
        const userId = await resolveSessionUserId(db, auth, sessionId);
        if (!userId) throw new UnauthorizedError();
        const row = await requireOwnKey(db, userId, keyId);
        let githubKeyId = row.githubKeyId;
        if (enabled && row.githubKeyId === null) {
          const token = await requireKeyToken(env, auth, db, userId);
          const registered = await registerGithubSigningKey(token, row.name, row.publicKey);
          if (!registered) throw new HttpError(502, { error: 'github_signing_key_registration_failed' });
          githubKeyId = registered.id;
        }
        if (!enabled && row.githubKeyId !== null) {
          const token = await requireKeyToken(env, auth, db, userId);
          await deleteGithubSigningKey(token, row.githubKeyId);
          githubKeyId = null;
        }
        const updated = await db.update(userSigningKeys).set({ enabled, githubKeyId }).where(eq(userSigningKeys.id, row.id)).returning();
        return statusResponse(env, auth, db, userId, updated[0]!);
      });
      return Response.json(payload);
    } finally {
      waitUntil(db.$client.end());
    }
  }
}
