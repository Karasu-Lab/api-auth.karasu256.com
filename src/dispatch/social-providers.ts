import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { createSocialProviders } from '../lib/social-providers';

export class ListSocialProvidersDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.request.method === 'GET' && this.context.pathname === '/api/internal/social-providers';
  }

  async handle(): Promise<Response> {
    return Response.json({ providerIds: Object.keys(createSocialProviders(this.context.env)) });
  }
}
