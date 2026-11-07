import { SignJWT, importPKCS8 } from 'jose';
import { z } from 'zod';
import { HttpError, Issue } from '@karasu-lab/types/server';

const GITHUB_API_URL = 'https://api.github.com';

export class GithubAppNotConfiguredError extends HttpError {
  constructor(issues: Issue[]) {
    super(503, { error: 'github_app_not_configured' }, undefined, issues);
    this.name = 'GithubAppNotConfiguredError';
  }
}

function missingEnvironmentVariable(name: string): Issue {
  return new Issue('missing_environment_variable', [name], `Missing required environment variable: ${name}`);
}

const installationSchema = z.object({
  id: z.number(),
  account: z.object({
    id: z.number(),
    login: z.string(),
    type: z.string(),
  }),
  suspended_at: z.string().nullable().optional(),
});

export type GithubAppInstallationInfo = z.infer<typeof installationSchema>;

const installationTokenSchema = z.object({
  token: z.string(),
  expires_at: z.string(),
});

const repositorySchema = z.object({
  id: z.number(),
  full_name: z.string(),
  name: z.string(),
  private: z.boolean(),
  html_url: z.string(),
  default_branch: z.string(),
});

export type GithubRepository = z.infer<typeof repositorySchema>;

const repositoryListSchema = z.object({
  total_count: z.number(),
  repositories: z.array(repositorySchema),
});

const pullRequestSchema = z.object({
  number: z.number(),
  html_url: z.string(),
  node_id: z.string(),
});

export type GithubPullRequest = z.infer<typeof pullRequestSchema>;

const tokenCache = new Map<number, { token: string; expiresAt: number }>();

function appCredentials(env: Env): { appId: string; privateKey: string } {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    const issues: Issue[] = [];
    if (!appId) issues.push(missingEnvironmentVariable('GITHUB_APP_ID'));
    if (!privateKey) issues.push(missingEnvironmentVariable('GITHUB_APP_PRIVATE_KEY'));
    throw new GithubAppNotConfiguredError(issues);
  }
  return { appId, privateKey: privateKey.replace(/\\n/g, '\n') };
}

export function appClientCredentials(env: Env): { clientId: string; clientSecret: string } {
  const clientId = env.GH_APP_CLIENT_ID;
  const clientSecret = env.GH_APP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const issues: Issue[] = [];
    if (!clientId) issues.push(missingEnvironmentVariable('GH_APP_CLIENT_ID'));
    if (!clientSecret) issues.push(missingEnvironmentVariable('GH_APP_CLIENT_SECRET'));
    throw new GithubAppNotConfiguredError(issues);
  }
  return { clientId, clientSecret };
}

const appSchema = z.object({
  html_url: z.string(),
});

export async function getAppPublicLink(env: Env): Promise<string> {
  const jwt = await createAppJwt(env);
  const app = await githubJson(jwt, '/app', appSchema);
  return app.html_url;
}

async function createAppJwt(env: Env): Promise<string> {
  const { appId, privateKey } = appCredentials(env);
  const key = await importPKCS8(privateKey, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(appId)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .sign(key);
}

async function githubFetch(token: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${GITHUB_API_URL}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'karasu-lab-api-auth',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
}

async function githubJson<T>(token: string, path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await githubFetch(token, path, init);
  if (!response.ok) {
    throw new HttpError(502, { error: 'github_api_error', status: response.status, path });
  }
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new HttpError(502, { error: 'github_api_invalid_response', path });
  return parsed.data;
}

export async function getInstallationInfo(env: Env, installationId: number): Promise<GithubAppInstallationInfo> {
  const jwt = await createAppJwt(env);
  return githubJson(jwt, `/app/installations/${installationId}`, installationSchema);
}

export async function getInstallationToken(env: Env, installationId: number): Promise<{ token: string; expiresAt: string }> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return { token: cached.token, expiresAt: new Date(cached.expiresAt).toISOString() };
  }
  const jwt = await createAppJwt(env);
  const issued = await githubJson(jwt, `/app/installations/${installationId}/access_tokens`, installationTokenSchema, {
    method: 'POST',
  });
  tokenCache.set(installationId, { token: issued.token, expiresAt: new Date(issued.expires_at).getTime() });
  return { token: issued.token, expiresAt: issued.expires_at };
}

export async function listInstallationRepositories(env: Env, installationId: number): Promise<GithubRepository[]> {
  const { token } = await getInstallationToken(env, installationId);
  const repositories: GithubRepository[] = [];
  let page = 1;
  for (;;) {
    const list = await githubJson(token, `/installation/repositories?per_page=100&page=${page}`, repositoryListSchema);
    repositories.push(...list.repositories);
    if (repositories.length >= list.total_count || list.repositories.length === 0) return repositories;
    page += 1;
  }
}

export async function createInstallationRepository(
  env: Env,
  installationId: number,
  target: { type: string; login: string },
  body: { name: string; description?: string; private?: boolean; isTemplate?: boolean }
): Promise<GithubRepository> {
  const { token } = await getInstallationToken(env, installationId);
  const path = target.type === 'Organization' ? `/orgs/${target.login}/repos` : '/user/repos';
  return githubJson(token, path, repositorySchema, {
    method: 'POST',
    body: JSON.stringify({
      name: body.name,
      description: body.description,
      private: body.private ?? true,
      is_template: body.isTemplate ?? false,
      auto_init: true,
    }),
  });
}

export async function createPullRequest(
  env: Env,
  installationId: number,
  repositoryFullName: string,
  body: { title: string; head: string; base: string; body?: string }
): Promise<GithubPullRequest> {
  const { token } = await getInstallationToken(env, installationId);
  return githubJson(token, `/repos/${repositoryFullName}/pulls`, pullRequestSchema, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function enablePullRequestAutoMerge(
  env: Env,
  installationId: number,
  pullRequestNodeId: string
): Promise<void> {
  const { token } = await getInstallationToken(env, installationId);
  const response = await githubFetch(token, '/graphql', {
    method: 'POST',
    body: JSON.stringify({
      query: 'mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: MERGE }) { clientMutationId } }',
      variables: { id: pullRequestNodeId },
    }),
  });
  if (!response.ok) throw new HttpError(502, { error: 'github_api_error', status: response.status, path: '/graphql' });
  const payload = (await response.json().catch(() => null)) as { errors?: unknown } | null;
  if (!payload || payload.errors) throw new HttpError(502, { error: 'github_api_invalid_response', path: '/graphql' });
}
