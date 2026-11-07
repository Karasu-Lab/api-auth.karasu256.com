import { z } from 'zod';
import { githubRepositorySchema, githubUserSchema, type GitHubRepository, type GitHubUser } from '@karasu-lab/types/shared';
import { BadRequestError, HttpError, NotFoundError } from '@karasu-lab/types/server';
import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { getAppPublicLink } from '../lib/github-app';
import { getProviderAccessToken } from '../lib/provider-profile';
import { withAuth } from '../lib/request-auth';

const GITHUB_USER_PATH = /^\/api\/internal\/users\/([^/]+)\/github\/user$/;
const GITHUB_REPOSITORIES_PATH = /^\/api\/internal\/users\/([^/]+)\/github\/repositories$/;

const userIdSchema = z.string().min(1);

const githubUserResponseSchema = z.object({
  id: z.number(),
  login: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  avatar_url: z.string(),
  html_url: z.string(),
});

const githubRepositoryResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
  html_url: z.string(),
  description: z.string().nullable(),
  language: z.string().nullable(),
  updated_at: z.string(),
});

const githubRepositoriesResponseSchema = z.array(githubRepositoryResponseSchema);

function pathUserId(pathname: string, pattern: RegExp): string {
  const match = pattern.exec(pathname);
  const parsed = userIdSchema.safeParse(match ? decodeURIComponent(match[1]) : null);
  if (!parsed.success) throw new BadRequestError();
  return parsed.data;
}

async function fetchGithub(env: Env, userId: string, path: string): Promise<unknown> {
  const accessToken = await withAuth(env, (auth) => getProviderAccessToken(auth, userId, 'github'));
  if (!accessToken) throw new NotFoundError();
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new HttpError(502, { error: 'github_request_failed' });
  return res.json();
}

export class GithubUserDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.request.method === 'GET' && GITHUB_USER_PATH.test(this.context.pathname);
  }

  async handle(): Promise<Response> {
    const userId = pathUserId(this.context.pathname, GITHUB_USER_PATH);
    const raw = githubUserResponseSchema.parse(await fetchGithub(this.context.env, userId, '/user'));
    const user: GitHubUser = githubUserSchema.parse({
      id: raw.id,
      login: raw.login,
      name: raw.name,
      email: raw.email,
      avatarUrl: raw.avatar_url,
      htmlUrl: raw.html_url,
    });
    return Response.json(user);
  }
}

export class GithubRepositoriesDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.request.method === 'GET' && GITHUB_REPOSITORIES_PATH.test(this.context.pathname);
  }

  async handle(): Promise<Response> {
    const userId = pathUserId(this.context.pathname, GITHUB_REPOSITORIES_PATH);
    const raw = githubRepositoriesResponseSchema.parse(await fetchGithub(this.context.env, userId, '/user/repos?per_page=100&sort=updated'));
    const repositories: GitHubRepository[] = raw.map((repository) =>
      githubRepositorySchema.parse({
        id: repository.id,
        name: repository.name,
        fullName: repository.full_name,
        private: repository.private,
        htmlUrl: repository.html_url,
        description: repository.description,
        language: repository.language,
        updatedAt: repository.updated_at,
      })
    );
    return Response.json(repositories);
  }
}

export class GithubAppInstallUrlDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.request.method === 'GET' && this.context.pathname === '/api/internal/github-app/install-url';
  }

  async handle(): Promise<Response> {
    const publicLink = await getAppPublicLink(this.context.env);
    return Response.json({ installUrl: `${publicLink}/installations/new` });
  }
}
