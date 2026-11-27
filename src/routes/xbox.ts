import { OAuthLinkFlow } from '../lib/oauth-link-flow';

export async function handleXboxLink(env: Env, request: Request): Promise<Response> {
  return new OAuthLinkFlow(env).startXboxLink(request);
}

export async function handleXboxAppLink(
  env: Env,
  request: Request,
  callbackURL?: string,
  providerId?: string,
): Promise<Response> {
  return new OAuthLinkFlow(env).startXboxAppLink(request, callbackURL, providerId);
}

export async function handleXboxCallback(env: Env, request: Request): Promise<Response> {
  return new OAuthLinkFlow(env).finishXboxLink(request);
}
