import { createDb } from '@karasu-lab/db/create-db';
import type { Db } from '@karasu-lab/db/create-db';
import { tenantSigningKeys, type TenantSigningKey } from '@karasu-lab/db/schema';
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
  generateSshKeyPair,
  getGithubSigningKey,
  getSigningKeyAccessToken,
  registerGithubSigningKey,
} from '../lib/signing-key';
import { TENANT_SETUP_ROLES, requireTenantRole, resolveSessionUserId } from '../lib/tenant';

const sessionBodySchema = z.object({
  sessionId: z.string().min(1),
  organizationId: z.string().min(1),
});

const createBodySchema = sessionBodySchema.extend(generateSigningKeyRequestSchema.shape);
const renameBodySchema = sessionBodySchema.extend(renameSigningKeyRequestSchema.shape);
const enabledBodySchema = sessionBodySchema.extend(setSigningKeyEnabledRequestSchema.shape);

async function statusResponse(
  env: Env,
  auth: Auth,
  db: Db,
  userId: string,
  row: TenantSigningKey
): Promise<SigningKeyStatusResponse> {
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

async function findKey(db: Db, organizationId: string, keyId: string): Promise<TenantSigningKey> {
  const rows = await db
    .select()
    .from(tenantSigningKeys)
    .where(and(eq(tenantSigningKeys.organizationId, organizationId), eq(tenantSigningKeys.id, keyId)))
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
    const { sessionId, organizationId, name } = parsed.data;

    const db = createDb(env.DATABASE_URL);
    try {
      const payload = await withAuth(env, async (auth) => {
        const userId = await resolveSessionUserId(db, auth, sessionId);
        if (!userId) throw new UnauthorizedError();
        await requireTenantRole(db, userId, organizationId, TENANT_SETUP_ROLES);
        const token = await requireKeyToken(env, auth, db, userId);
        const pair = await generateSshKeyPair();
        const registered = await registerGithubSigningKey(token, name, pair.publicKey);
        if (!registered) throw new HttpError(502, { error: 'github_signing_key_registration_failed' });
        const inserted = await db
          .insert(tenantSigningKeys)
          .values({
            organizationId,
            createdByUserId: userId,
            name,
            publicKey: pair.publicKey,
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
        organizationId: z.string().min(1),
        publicKeyId: z.string().min(1),
      })
      .safeParse({
        sessionId: query.get('sessionId'),
        organizationId: query.get('organizationId'),
        publicKeyId: query.get('publicKeyId'),
      });
    if (!parsed.success) throw new BadRequestError();
    const { sessionId, organizationId, publicKeyId } = parsed.data;

    const db = createDb(env.DATABASE_URL);
    try {
      const payload = await withAuth(env, async (auth) => {
        const userId = await resolveSessionUserId(db, auth, sessionId);
        if (!userId) throw new UnauthorizedError();
        await requireTenantRole(db, userId, organizationId, ['owner', 'admin', 'member']);
        const byId = await db
          .select()
          .from(tenantSigningKeys)
          .where(and(eq(tenantSigningKeys.organizationId, organizationId), eq(tenantSigningKeys.id, publicKeyId)))
          .limit(1);
        let row = byId[0];
        if (!row && /^\d+$/.test(publicKeyId)) {
          const byGithubId = await db
            .select()
            .from(tenantSigningKeys)
            .where(
              and(
                eq(tenantSigningKeys.organizationId, organizationId),
                eq(tenantSigningKeys.githubKeyId, Number(publicKeyId))
              )
            )
            .limit(1);
          row = byGithubId[0];
        }
        if (!row) throw new NotFoundError();
        return statusResponse(env, auth, db, userId, row);
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
    const { sessionId, organizationId } = parsed.data;

    const db = createDb(env.DATABASE_URL);
    try {
      const payload = await withAuth(env, async (auth) => {
        const userId = await resolveSessionUserId(db, auth, sessionId);
        if (!userId) throw new UnauthorizedError();
        await requireTenantRole(db, userId, organizationId, TENANT_SETUP_ROLES);
        const row = await findKey(db, organizationId, keyId);
        const token = await requireKeyToken(env, auth, db, userId);
        const pair = await generateSshKeyPair();
        const registered = await registerGithubSigningKey(token, row.name, pair.publicKey);
        if (!registered) throw new HttpError(502, { error: 'github_signing_key_registration_failed' });
        if (row.githubKeyId !== null) await deleteGithubSigningKey(token, row.githubKeyId);
        const updated = await db
          .update(tenantSigningKeys)
          .set({
            publicKey: pair.publicKey,
            publicKeyFingerprint: pair.fingerprint,
            githubKeyId: registered.id,
            enabled: true,
          })
          .where(eq(tenantSigningKeys.id, row.id))
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
    const { sessionId, organizationId, name } = parsed.data;

    const db = createDb(env.DATABASE_URL);
    try {
      const payload = await withAuth(env, async (auth) => {
        const userId = await resolveSessionUserId(db, auth, sessionId);
        if (!userId) throw new UnauthorizedError();
        await requireTenantRole(db, userId, organizationId, TENANT_SETUP_ROLES);
        const row = await findKey(db, organizationId, keyId);
        let githubKeyId = row.githubKeyId;
        if (row.githubKeyId !== null) {
          const token = await requireKeyToken(env, auth, db, userId);
          const registered = await registerGithubSigningKey(token, name, row.publicKey);
          if (!registered) throw new HttpError(502, { error: 'github_signing_key_registration_failed' });
          await deleteGithubSigningKey(token, row.githubKeyId);
          githubKeyId = registered.id;
        }
        const updated = await db
          .update(tenantSigningKeys)
          .set({ name, githubKeyId })
          .where(eq(tenantSigningKeys.id, row.id))
          .returning();
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
    const { sessionId, organizationId, enabled } = parsed.data;

    const db = createDb(env.DATABASE_URL);
    try {
      const payload = await withAuth(env, async (auth) => {
        const userId = await resolveSessionUserId(db, auth, sessionId);
        if (!userId) throw new UnauthorizedError();
        await requireTenantRole(db, userId, organizationId, TENANT_SETUP_ROLES);
        const row = await findKey(db, organizationId, keyId);
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
        const updated = await db
          .update(tenantSigningKeys)
          .set({ enabled, githubKeyId })
          .where(eq(tenantSigningKeys.id, row.id))
          .returning();
        return statusResponse(env, auth, db, userId, updated[0]!);
      });
      return Response.json(payload);
    } finally {
      waitUntil(db.$client.end());
    }
  }
}
