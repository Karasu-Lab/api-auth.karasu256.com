import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { listProviderIds } from '../lib/provider-list';

export class ListProvidersDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.request.method === 'GET' && this.context.pathname === '/api/internal/providers';
  }

  async handle(): Promise<Response> {
    return Response.json({ providerIds: listProviderIds(this.context.env) });
  }
}
