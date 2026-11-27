import { OAuthLinkFlow } from '../lib/oauth-link-flow';

export async function handleOAuthLink(env: Env, request: Request): Promise<Response> {
  return new OAuthLinkFlow(env).startLink(request);
}

export async function handleOAuthSignIn(env: Env, request: Request): Promise<Response> {
  return new OAuthLinkFlow(env).startSignIn(request);
}

export async function handleOAuthLinkHandoff(env: Env, request: Request): Promise<Response> {
  return new OAuthLinkFlow(env).continueLink(request);
}
