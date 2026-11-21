import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { withAuth } from '../lib/request-auth';

const METADATA_PATHS: Record<string, string> = {
  '/.well-known/openid-configuration': '/api/auth/.well-known/openid-configuration',
  '/.well-known/openid-configuration/api/auth': '/api/auth/.well-known/openid-configuration',
  '/.well-known/oauth-authorization-server': '/api/auth/.well-known/oauth-authorization-server',
  '/.well-known/oauth-authorization-server/api/auth': '/api/auth/.well-known/oauth-authorization-server',
};

export class WellKnownMetadataDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.request.method === 'GET' && this.context.pathname in METADATA_PATHS;
  }

  async handle(): Promise<Response> {
    const { env, request, pathname } = this.context;
    const target = new URL(METADATA_PATHS[pathname], request.url);
    const response = await withAuth(env, (auth) => auth.handler(new Request(target, { headers: request.headers })));
    const headers = new Headers(response.headers);
    headers.set('access-control-allow-origin', '*');
    return new Response(response.body, { status: response.status, headers });
  }
}
