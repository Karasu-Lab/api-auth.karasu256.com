import { createDb } from '@karasu-lab/db/create-db';
import { members, tenantGithubInstallations } from '@karasu-lab/db/schema';
import { waitUntil } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { getAuthConfig } from '../config';
import { getAppPublicLink, getInstallationInfo, GithubAppNotConfiguredError } from '../lib/github-app';
import { createLinkState, verifyLinkState } from '../lib/link-state';
import { withAuth } from '../lib/request-auth';

const STATE_KIND = 'github-app-install';
export const GITHUB_APP_STATE_COOKIE = 'github_app_install_state';

function isTrustedReturnTo(env: Env, returnTo: string): boolean {
  const { trustedOrigins } = getAuthConfig(env);
  return trustedOrigins.some((origin) => returnTo === origin || returnTo.startsWith(`${origin}/`));
}

export async function handleGithubAppInstall(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get('organizationId');
  const returnTo = url.searchParams.get('returnTo');
  return withAuth(env, async (auth) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      const next = encodeURIComponent(url.toString());
      return Response.redirect(`${env.AUTH_UI_URL.replace(/\/+$/, '')}/sign-in?next=${next}`, 302);
    }
    if (!organizationId || !returnTo || !isTrustedReturnTo(env, returnTo)) {
      return Response.json({ error: 'Bad Request' }, { status: 400 });
    }
    const db = createDb(env.DATABASE_URL);
    try {
      const rows = await db
        .select({ role: members.role })
        .from(members)
        .where(and(eq(members.userId, session.user.id), eq(members.organizationId, organizationId)))
        .limit(1);
      const role = rows[0]?.role;
      if (role !== 'owner' && role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });
    } finally {
      waitUntil(db.$client.end());
    }
    let publicLink: string;
    try {
      publicLink = await getAppPublicLink(env);
    } catch (caught) {
      if (caught instanceof GithubAppNotConfiguredError) {
        return Response.json(caught.body, { status: caught.status });
      }
      throw caught;
    }
    const state = await createLinkState(env.BETTER_AUTH_SECRET, {
      kind: STATE_KIND,
      userId: session.user.id,
      organizationId,
      returnTo,
    });
    const destination = `${publicLink}/installations/new?state=${encodeURIComponent(state)}`;
    return new Response(null, {
      status: 302,
      headers: {
        location: destination,
        'set-cookie': `${GITHUB_APP_STATE_COOKIE}=${encodeURIComponent(state)}; Path=/api/github-app; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      },
    });
  });
}

export async function handleGithubAppCallback(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cookieState = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${GITHUB_APP_STATE_COOKIE}=`))
    ?.slice(GITHUB_APP_STATE_COOKIE.length + 1);
  const state = url.searchParams.get('state') ?? (cookieState ? decodeURIComponent(cookieState) : null);
  const fallback = `${env.ACCOUNTS_URL.replace(/\/+$/, '')}/settings`;
  if (!state) return Response.redirect(`${fallback}?error=github_app_state_missing`, 302);
  const payload = await verifyLinkState(env.BETTER_AUTH_SECRET, state);
  if (!payload || payload.kind !== STATE_KIND) {
    return Response.redirect(`${fallback}?error=github_app_state_invalid`, 302);
  }
  const destination = new URL(payload.returnTo);
  const fail = (error: string) => {
    destination.searchParams.set('error', error);
    return Response.redirect(destination.toString(), 302);
  };
  if (!payload.organizationId) return fail('github_app_state_invalid');
  const organizationId = payload.organizationId;
  if (url.searchParams.get('setup_action') === 'request') return fail('github_app_installation_requested');
  const installationIdRaw = url.searchParams.get('installation_id');
  const installationId = installationIdRaw ? Number(installationIdRaw) : NaN;
  if (!Number.isFinite(installationId)) return fail('github_app_installation_missing');

  try {
    await withAuth(env, async (auth) => {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session || session.user.id !== payload.userId) throw new Error('session_mismatch');
      const info = await getInstallationInfo(env, installationId);
      const targetType = info.account.type === 'Organization' ? 'organization' : 'user';
      const db = createDb(env.DATABASE_URL);
      try {
        const values = {
          installationId: info.id,
          targetType,
          targetId: info.account.id,
          targetLogin: info.account.login,
          installedByUserId: session.user.id,
          suspended: info.suspended_at != null,
        };
        await db
          .insert(tenantGithubInstallations)
          .values({ organizationId, ...values })
          .onConflictDoUpdate({ target: tenantGithubInstallations.organizationId, set: values });
      } finally {
        waitUntil(db.$client.end());
      }
    });
  } catch {
    return fail('github_app_installation_failed');
  }
  destination.searchParams.set('githubApp', 'installed');
  return Response.redirect(destination.toString(), 302);
}
