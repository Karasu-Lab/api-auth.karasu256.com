import { createDb } from '@karasu-lab/db/create-db';
import type { Db } from '@karasu-lab/db/create-db';
import {
  members,
  organizations,
  tenantGithubInstallations,
  tenantLinkedPackages,
  userSigningKeys,
  users,
  type TenantGithubInstallation,
} from '@karasu-lab/db/schema';
import { waitUntil } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { BadRequestError, HttpError, NotFoundError } from '@karasu-lab/types/server';
import { githubInstallationWebhookActionSchema } from '@karasu-lab/types/shared';
import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import {
  createInstallationRepository,
  createPullRequest,
  deleteInstallation,
  enablePullRequestAutoMerge,
  getInstallationInfo,
  getInstallationToken,
  listInstallationRepositories,
} from '../lib/github-app';
import { TENANT_SETUP_ROLES, requireTenantRole } from '../lib/tenant';

function tenantSegment(pathname: string, suffix: string): string | null {
  const prefix = '/api/internal/tenants/';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  const id = pathname.slice(prefix.length, pathname.length - suffix.length);
  return id.length > 0 && !id.includes('/') ? id : null;
}

function userTenantsSegment(pathname: string): string | null {
  const prefix = '/api/internal/users/';
  const suffix = '/tenants';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  const id = pathname.slice(prefix.length, pathname.length - suffix.length);
  return id.length > 0 && !id.includes('/') ? id : null;
}

function packageSegment(pathname: string, suffix: string): { organizationId: string; packageId: string } | null {
  const prefix = '/api/internal/tenants/';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  const rest = pathname.slice(prefix.length, pathname.length - suffix.length);
  const parts = rest.split('/');
  if (parts.length !== 3 || parts[1] !== 'packages' || !parts[0] || !parts[2]) return null;
  return { organizationId: parts[0], packageId: parts[2] };
}

async function requireInstallation(db: Db, organizationId: string): Promise<TenantGithubInstallation> {
  const rows = await db
    .select()
    .from(tenantGithubInstallations)
    .where(eq(tenantGithubInstallations.organizationId, organizationId))
    .limit(1);
  if (!rows[0]) throw new HttpError(409, { error: 'github_app_not_installed' });
  return rows[0];
}

function installationPayload(row: TenantGithubInstallation) {
  return {
    id: row.id,
    installationId: row.installationId,
    targetType: row.targetType,
    targetId: row.targetId,
    targetLogin: row.targetLogin,
    suspended: row.suspended,
    installedByUserId: row.installedByUserId,
  };
}

export class ListUserTenantsDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return userTenantsSegment(this.context.pathname) !== null && this.context.request.method === 'GET';
  }

  async handle(): Promise<Response> {
    const { env } = this.context;
    const userId = userTenantsSegment(this.context.pathname)!;
    const db = createDb(env.DATABASE_URL);
    try {
      const rows = await db
        .select({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
          logo: organizations.logo,
          role: members.role,
        })
        .from(members)
        .innerJoin(organizations, eq(members.organizationId, organizations.id))
        .where(eq(members.userId, userId));
      return Response.json({ tenants: rows });
    } finally {
      waitUntil(db.$client.end());
    }
  }
}

export class TenantOverviewDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return tenantSegment(this.context.pathname, '/overview') !== null && this.context.request.method === 'GET';
  }

  async handle(): Promise<Response> {
    const { env, request } = this.context;
    const organizationId = tenantSegment(this.context.pathname, '/overview')!;
    const userId = new URL(request.url).searchParams.get('userId');
    if (!userId) throw new BadRequestError();
    const db = createDb(env.DATABASE_URL);
    try {
      const role = await requireTenantRole(db, userId, organizationId, ['owner', 'admin', 'member']);
      const orgRows = await db.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1);
      if (!orgRows[0]) throw new NotFoundError();
      const [installationRows, packageRows, keyRows] = await Promise.all([
        db.select().from(tenantGithubInstallations).where(eq(tenantGithubInstallations.organizationId, organizationId)).limit(1),
        db.select().from(tenantLinkedPackages).where(eq(tenantLinkedPackages.organizationId, organizationId)),
        db.select().from(userSigningKeys).where(eq(userSigningKeys.userId, userId)),
      ]);
      return Response.json({
        organization: { id: orgRows[0].id, name: orgRows[0].name, slug: orgRows[0].slug, role },
        installation: installationRows[0] ? installationPayload(installationRows[0]) : null,
        linkedPackages: packageRows.map((row) => ({
          id: row.id,
          repositoryId: row.repositoryId,
          repositoryFullName: row.repositoryFullName,
          submodulePath: row.npmSubmodulePath,
          versionNaming: row.versionNaming,
          enabled: row.webhookEnabled,
          lastSyncedSha: row.lastSyncedSha,
        })),
        signingKeys: keyRows.map((row) => ({
          id: row.id,
          publicKeyId: row.githubKeyId !== null ? String(row.githubKeyId) : row.id,
          name: row.name,
          enabled: row.enabled,
          registeredOnGitHub: row.enabled && row.githubKeyId !== null,
          publicKey: row.publicKey,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
      });
    } finally {
      waitUntil(db.$client.end());
    }
  }
}

export class TenantInstallationDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return tenantSegment(this.context.pathname, '/github-installation') !== null && this.context.request.method === 'GET';
  }

  async handle(): Promise<Response> {
    const { env } = this.context;
    const organizationId = tenantSegment(this.context.pathname, '/github-installation')!;
    const db = createDb(env.DATABASE_URL);
    try {
      const rows = await db
        .select()
        .from(tenantGithubInstallations)
        .where(eq(tenantGithubInstallations.organizationId, organizationId))
        .limit(1);
      if (!rows[0]) return Response.json({ installation: null });
      const row = rows[0];
      const live = await getInstallationInfo(env, row.installationId).catch(() => null);
      return Response.json({
        installation: {
          ...installationPayload(row),
          suspended: live ? live.suspended_at != null : row.suspended,
          targetLogin: live ? live.account.login : row.targetLogin,
        },
      });
    } finally {
      waitUntil(db.$client.end());
    }
  }
}

const uninstallBotBodySchema = z.object({
  userId: z.string().min(1),
});

export class UninstallBotDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return tenantSegment(this.context.pathname, '/github-installation') !== null && this.context.request.method === 'DELETE';
  }

  async handle(): Promise<Response> {
    const { env } = this.context;
    const organizationId = tenantSegment(this.context.pathname, '/github-installation')!;
    const parsed = uninstallBotBodySchema.safeParse(this.context.body);
    if (!parsed.success) throw new BadRequestError();
    const db = createDb(env.DATABASE_URL);
    try {
      await requireTenantRole(db, parsed.data.userId, organizationId, TENANT_SETUP_ROLES);
      const installation = await requireInstallation(db, organizationId);
      await deleteInstallation(env, installation.installationId);
      await db
        .delete(tenantGithubInstallations)
        .where(eq(tenantGithubInstallations.organizationId, organizationId));
      return Response.json({ uninstalled: true });
    } finally {
      waitUntil(db.$client.end());
    }
  }
}

export class TenantRepositoriesDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return tenantSegment(this.context.pathname, '/github-repositories') !== null && this.context.request.method === 'GET';
  }

  async handle(): Promise<Response> {
    const { env } = this.context;
    const organizationId = tenantSegment(this.context.pathname, '/github-repositories')!;
    const db = createDb(env.DATABASE_URL);
    try {
      const installation = await requireInstallation(db, organizationId);
      const repositories = await listInstallationRepositories(env, installation.installationId);
      return Response.json({
        repositories: repositories.map((repo) => ({
          id: repo.id,
          fullName: repo.full_name,
          name: repo.name,
          private: repo.private,
          htmlUrl: repo.html_url,
          defaultBranch: repo.default_branch,
        })),
      });
    } finally {
      waitUntil(db.$client.end());
    }
  }
}

const createRepositoryBodySchema = z.object({
  userId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(350).optional(),
  private: z.boolean().optional(),
  isTemplate: z.boolean().optional(),
});

export class CreateTenantRepositoryDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return tenantSegment(this.context.pathname, '/github-repositories') !== null && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    const { env } = this.context;
    const organizationId = tenantSegment(this.context.pathname, '/github-repositories')!;
    const parsed = createRepositoryBodySchema.safeParse(this.context.body);
    if (!parsed.success) throw new BadRequestError();
    const db = createDb(env.DATABASE_URL);
    try {
      await requireTenantRole(db, parsed.data.userId, organizationId, TENANT_SETUP_ROLES);
      const installation = await requireInstallation(db, organizationId);
      const repo = await createInstallationRepository(
        env,
        installation.installationId,
        { type: installation.targetType === 'organization' ? 'Organization' : 'User', login: installation.targetLogin },
        parsed.data
      );
      return Response.json({
        repository: {
          id: repo.id,
          fullName: repo.full_name,
          name: repo.name,
          private: repo.private,
          htmlUrl: repo.html_url,
          defaultBranch: repo.default_branch,
        },
      });
    } finally {
      waitUntil(db.$client.end());
    }
  }
}

export class InstallationTokenDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return tenantSegment(this.context.pathname, '/github-installation-token') !== null && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    const { env } = this.context;
    const organizationId = tenantSegment(this.context.pathname, '/github-installation-token')!;
    const db = createDb(env.DATABASE_URL);
    try {
      const installation = await requireInstallation(db, organizationId);
      const issued = await getInstallationToken(env, installation.installationId);
      return Response.json(issued);
    } finally {
      waitUntil(db.$client.end());
    }
  }
}

const linkPackageBodySchema = z.object({
  userId: z.string().min(1),
  repositoryId: z.number(),
  repositoryFullName: z.string().min(1),
  submodulePath: z.string().min(1),
  versionNaming: z.string().min(1),
});

export class LinkPackageDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return tenantSegment(this.context.pathname, '/packages') !== null && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    const { env } = this.context;
    const organizationId = tenantSegment(this.context.pathname, '/packages')!;
    const parsed = linkPackageBodySchema.safeParse(this.context.body);
    if (!parsed.success) throw new BadRequestError();
    const { userId, ...values } = parsed.data;
    const db = createDb(env.DATABASE_URL);
    try {
      await requireTenantRole(db, userId, organizationId, TENANT_SETUP_ROLES);
      const inserted = await db
        .insert(tenantLinkedPackages)
        .values({
          organizationId,
          repositoryId: values.repositoryId,
          repositoryFullName: values.repositoryFullName,
          npmSubmodulePath: values.submodulePath,
          versionNaming: values.versionNaming,
        })
        .onConflictDoUpdate({
          target: [tenantLinkedPackages.organizationId, tenantLinkedPackages.repositoryId],
          set: {
            repositoryFullName: values.repositoryFullName,
            npmSubmodulePath: values.submodulePath,
            versionNaming: values.versionNaming,
          },
        })
        .returning();
      return Response.json({ package: { id: inserted[0]!.id } });
    } finally {
      waitUntil(db.$client.end());
    }
  }
}

const setEnabledBodySchema = z.object({ userId: z.string().min(1), enabled: z.boolean() });

export class SetLinkedPackageEnabledDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return packageSegment(this.context.pathname, '/enabled') !== null && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    const { env } = this.context;
    const segment = packageSegment(this.context.pathname, '/enabled')!;
    const parsed = setEnabledBodySchema.safeParse(this.context.body);
    if (!parsed.success) throw new BadRequestError();
    const db = createDb(env.DATABASE_URL);
    try {
      await requireTenantRole(db, parsed.data.userId, segment.organizationId, TENANT_SETUP_ROLES);
      const updated = await db
        .update(tenantLinkedPackages)
        .set({ webhookEnabled: parsed.data.enabled })
        .where(
          and(
            eq(tenantLinkedPackages.organizationId, segment.organizationId),
            eq(tenantLinkedPackages.id, segment.packageId)
          )
        )
        .returning();
      if (!updated[0]) throw new NotFoundError();
      return Response.json({ enabled: updated[0].webhookEnabled });
    } finally {
      waitUntil(db.$client.end());
    }
  }
}

const pointerBodySchema = z.object({ sha: z.string().min(7) });

export class UpdateLinkedPackagePointerDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return packageSegment(this.context.pathname, '/pointer') !== null && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    const { env } = this.context;
    const segment = packageSegment(this.context.pathname, '/pointer')!;
    const parsed = pointerBodySchema.safeParse(this.context.body);
    if (!parsed.success) throw new BadRequestError();
    const db = createDb(env.DATABASE_URL);
    try {
      const updated = await db
        .update(tenantLinkedPackages)
        .set({ lastSyncedSha: parsed.data.sha })
        .where(
          and(
            eq(tenantLinkedPackages.organizationId, segment.organizationId),
            eq(tenantLinkedPackages.id, segment.packageId)
          )
        )
        .returning();
      if (!updated[0]) throw new NotFoundError();
      return Response.json({ lastSyncedSha: updated[0].lastSyncedSha });
    } finally {
      waitUntil(db.$client.end());
    }
  }
}

const pushWebhookBodySchema = z.object({
  installationId: z.number(),
  repositoryFullName: z.string().min(1),
  afterSha: z.string().min(7),
});

export class PushWebhookDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname === '/api/internal/webhooks/push' && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    const { env } = this.context;
    const parsed = pushWebhookBodySchema.safeParse(this.context.body);
    if (!parsed.success) throw new BadRequestError();
    const { installationId, repositoryFullName, afterSha } = parsed.data;
    const db = createDb(env.DATABASE_URL);
    try {
      const installationRows = await db
        .select()
        .from(tenantGithubInstallations)
        .where(eq(tenantGithubInstallations.installationId, installationId))
        .limit(1);
      const installation = installationRows[0];
      if (!installation) return Response.json({ accepted: false, reason: 'installation_not_linked' });
      const organizationId = installation.organizationId;
      const packageRows = await db
        .select()
        .from(tenantLinkedPackages)
        .where(
          and(
            eq(tenantLinkedPackages.organizationId, organizationId),
            eq(tenantLinkedPackages.repositoryFullName, repositoryFullName)
          )
        )
        .limit(1);
      const linked = packageRows[0];
      if (!linked) return Response.json({ accepted: false, reason: 'package_not_linked' });
      if (!linked.webhookEnabled) return Response.json({ accepted: false, reason: 'package_disabled' });
      if (linked.lastSyncedSha === afterSha) return Response.json({ accepted: false, reason: 'already_synced' });
      const signingUserId = installation.installedByUserId;
      if (!signingUserId) return Response.json({ accepted: false, reason: 'signing_user_unknown' });
      const keyRows = await db
        .select()
        .from(userSigningKeys)
        .where(and(eq(userSigningKeys.userId, signingUserId), eq(userSigningKeys.enabled, true)))
        .limit(1);
      if (!keyRows[0]) return Response.json({ accepted: false, reason: 'signing_key_not_available' });
      const userRows = await db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, signingUserId))
        .limit(1);
      const signingKeyOwner = userRows[0] ?? null;
      if (!signingKeyOwner?.name || !signingKeyOwner?.email) {
        return Response.json({ accepted: false, reason: 'signing_key_owner_incomplete' });
      }
      return Response.json({
        accepted: true,
        organizationId,
        installationId,
        signingUserId,
        package: {
          id: linked.id,
          repositoryFullName: linked.repositoryFullName,
          submodulePath: linked.npmSubmodulePath,
          lastSyncedSha: linked.lastSyncedSha,
        },
        signingKeyOwner,
      });
    } finally {
      waitUntil(db.$client.end());
    }
  }
}

const installationWebhookBodySchema = z.object({
  installationId: z.number(),
  action: githubInstallationWebhookActionSchema,
});

export class InstallationWebhookDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname === '/api/internal/webhooks/installation' && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    const { env } = this.context;
    const parsed = installationWebhookBodySchema.safeParse(this.context.body);
    if (!parsed.success) throw new BadRequestError();
    const { installationId, action } = parsed.data;
    const db = createDb(env.DATABASE_URL);
    try {
      const rows = await db
        .select()
        .from(tenantGithubInstallations)
        .where(eq(tenantGithubInstallations.installationId, installationId))
        .limit(1);
      const row = rows[0];
      if (!row) return Response.json({ accepted: false, reason: 'installation_not_linked' });
      const organizationId = row.organizationId;
      if (action === 'deleted') {
        await db
          .delete(tenantGithubInstallations)
          .where(eq(tenantGithubInstallations.organizationId, organizationId));
        return Response.json({ accepted: true, organizationId, action });
      }
      if (action === 'suspend' || action === 'unsuspend') {
        await db
          .update(tenantGithubInstallations)
          .set({ suspended: action === 'suspend' })
          .where(eq(tenantGithubInstallations.organizationId, organizationId));
        return Response.json({ accepted: true, organizationId, action });
      }
      const live = await getInstallationInfo(env, installationId).catch(() => null);
      if (!live) return Response.json({ accepted: false, reason: 'installation_lookup_failed' });
      await db
        .update(tenantGithubInstallations)
        .set({
          targetType: live.account.type === 'Organization' ? 'organization' : 'user',
          targetId: live.account.id,
          targetLogin: live.account.login,
          suspended: live.suspended_at != null,
        })
        .where(eq(tenantGithubInstallations.organizationId, organizationId));
      return Response.json({ accepted: true, organizationId, action });
    } finally {
      waitUntil(db.$client.end());
    }
  }
}

const createPullRequestBodySchema = z.object({
  organizationId: z.string().min(1),
  repositoryFullName: z.string().min(1),
  title: z.string().min(1),
  head: z.string().min(1),
  base: z.string().min(1),
  body: z.string().optional(),
  enableAutoMerge: z.boolean().optional(),
});

export class CreateBotPullRequestDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.pathname === '/api/internal/github/pulls' && this.context.request.method === 'POST';
  }

  async handle(): Promise<Response> {
    const { env } = this.context;
    const parsed = createPullRequestBodySchema.safeParse(this.context.body);
    if (!parsed.success) throw new BadRequestError();
    const { organizationId, repositoryFullName, enableAutoMerge, ...pull } = parsed.data;
    const db = createDb(env.DATABASE_URL);
    try {
      const installation = await requireInstallation(db, organizationId);
      const created = await createPullRequest(env, installation.installationId, repositoryFullName, pull);
      if (enableAutoMerge) {
        await enablePullRequestAutoMerge(env, installation.installationId, created.node_id);
      }
      return Response.json({
        pullRequest: { number: created.number, url: created.html_url, autoMergeEnabled: enableAutoMerge ?? false },
      });
    } finally {
      waitUntil(db.$client.end());
    }
  }
}
