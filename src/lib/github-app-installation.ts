import { createDb } from '@karasu-lab/db/create-db';
import { accounts, members, tenantGithubInstallations } from '@karasu-lab/db/schema';
import { log } from '@karasu-lab/utils/server';
import { createAuthMiddleware, getOAuthState } from 'better-auth/api';
import { waitUntil } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { getInstallationInfo } from './github-app';
import { GITHUB_APP_PROVIDER_ID } from './github-providers';

export function githubAppInstallationPlugin(env: Env) {
  return {
    id: 'github-app-installation',
    hooks: {
      after: [
        {
          matcher: (context: { params?: { id?: string } }) => context.params?.id === GITHUB_APP_PROVIDER_ID,
          handler: createAuthMiddleware(async (ctx) => {
            const state = await getOAuthState<{ organizationId?: unknown }>().catch(() => null);
            const organizationId = typeof state?.organizationId === 'string' ? state.organizationId : null;
            const userId = state?.link?.userId ?? null;
            if (!organizationId || !userId) return;
            const installationIdRaw = typeof ctx.query?.installation_id === 'string' ? ctx.query.installation_id : null;
            const installationId = installationIdRaw ? Number(installationIdRaw) : NaN;
            if (!Number.isFinite(installationId)) {
              log('github_app_installation_not_recorded', { reason: 'installation_id_missing', organizationId, userId }, 'warn');
              return;
            }
            const db = createDb(env.DATABASE_URL);
            try {
              const linked = await db
                .select({ id: accounts.id })
                .from(accounts)
                .where(and(eq(accounts.userId, userId), eq(accounts.providerId, GITHUB_APP_PROVIDER_ID)))
                .limit(1);
              if (!linked[0]) return;
              const roleRows = await db
                .select({ role: members.role })
                .from(members)
                .where(and(eq(members.userId, userId), eq(members.organizationId, organizationId)))
                .limit(1);
              const role = roleRows[0]?.role;
              if (role !== 'owner' && role !== 'admin') {
                log('github_app_installation_not_recorded', { reason: 'tenant_setup_role_required', organizationId, userId }, 'warn');
                return;
              }
              const info = await getInstallationInfo(env, installationId);
              const values = {
                installationId: info.id,
                targetType: info.account.type === 'Organization' ? ('organization' as const) : ('user' as const),
                targetId: info.account.id,
                targetLogin: info.account.login,
                installedByUserId: userId,
                suspended: info.suspended_at != null,
              };
              await db
                .insert(tenantGithubInstallations)
                .values({ organizationId, ...values })
                .onConflictDoUpdate({ target: tenantGithubInstallations.organizationId, set: values });
            } catch (error) {
              log(
                'github_app_installation_not_recorded',
                { reason: 'record_failed', message: error instanceof Error ? error.message : String(error), organizationId, userId },
                'error'
              );
            } finally {
              waitUntil(db.$client.end());
            }
          }),
        },
      ],
    },
  };
}
