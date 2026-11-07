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

export class GithubInstallationNotFoundError extends HttpError {
  constructor() {
    super(404, { error: 'installation_not_found' });
    this.name = 'GithubInstallationNotFoundError';
  }
}

function isGithubApiErrorWithStatus(error: unknown, status: number): boolean {
  return error instanceof HttpError && error.body.error === 'github_api_error' && error.body.status === status;
}

const appCredentialsSchema = z.object({
  GH_APP_ID: z.string().min(1),
  GH_APP_PRIVATE_KEY: z.string().min(1),
});

const appClientCredentialsSchema = z.object({
  GH_APP_CLIENT_ID: z.string().min(1),
  GH_APP_CLIENT_SECRET: z.string().min(1),
});

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

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>= 8) bytes.unshift(value & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function toPkcs8Pem(pem: string): string {
  if (!pem.includes('BEGIN RSA PRIVATE KEY')) return pem;
  const pkcs1Der = Buffer.from(
    pem.replace('-----BEGIN RSA PRIVATE KEY-----', '').replace('-----END RSA PRIVATE KEY-----', '').replace(/\s+/g, ''),
    'base64',
  );
  const algorithmIdentifier = Buffer.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const body = Buffer.concat([
    Buffer.from([0x02, 0x01, 0x00]),
    algorithmIdentifier,
    Buffer.from([0x04, ...derLength(pkcs1Der.length)]),
    pkcs1Der,
  ]);
  const pkcs8Der = Buffer.concat([Buffer.from([0x30, ...derLength(body.length)]), body]);
  const lines = pkcs8Der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`;
}

function appCredentials(env: Env): { appId: string; privateKey: string } {
  const parsed = appCredentialsSchema.safeParse(env);
  if (!parsed.success) throw new GithubAppNotConfiguredError(Issue.fromZodError(parsed.error));
  return { appId: parsed.data.GH_APP_ID, privateKey: toPkcs8Pem(parsed.data.GH_APP_PRIVATE_KEY.replace(/\\n/g, '\n')) };
}

export function appClientCredentials(env: Env): { clientId: string; clientSecret: string } {
  const parsed = appClientCredentialsSchema.safeParse(env);
  if (!parsed.success) throw new GithubAppNotConfiguredError(Issue.fromZodError(parsed.error));
  return { clientId: parsed.data.GH_APP_CLIENT_ID, clientSecret: parsed.data.GH_APP_CLIENT_SECRET };
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
  try {
    return await githubJson(jwt, `/app/installations/${installationId}`, installationSchema);
  } catch (error) {
    if (isGithubApiErrorWithStatus(error, 404)) throw new GithubInstallationNotFoundError();
    throw error;
  }
}

export async function listAppInstallations(env: Env): Promise<GithubAppInstallationInfo[]> {
  const jwt = await createAppJwt(env);
  return githubJson(jwt, '/app/installations?per_page=100', z.array(installationSchema));
}

export async function deleteInstallation(env: Env, installationId: number): Promise<void> {
  const jwt = await createAppJwt(env);
  const path = `/app/installations/${installationId}`;
  const response = await githubFetch(jwt, path, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    throw new HttpError(502, { error: 'github_api_error', status: response.status, path });
  }
  tokenCache.delete(installationId);
}

export async function getInstallationToken(env: Env, installationId: number): Promise<{ token: string; expiresAt: string }> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return { token: cached.token, expiresAt: new Date(cached.expiresAt).toISOString() };
  }
  const jwt = await createAppJwt(env);
  let issued: z.infer<typeof installationTokenSchema>;
  try {
    issued = await githubJson(jwt, `/app/installations/${installationId}/access_tokens`, installationTokenSchema, {
      method: 'POST',
    });
  } catch (error) {
    if (isGithubApiErrorWithStatus(error, 404)) throw new GithubInstallationNotFoundError();
    throw error;
  }
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
