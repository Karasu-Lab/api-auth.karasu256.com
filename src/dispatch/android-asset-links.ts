import type { Dispatchable, DispatchContext } from '../lib/dispatch';
import { handleAndroidAssetLinks } from '../lib/android-asset-links';

export class AndroidAssetLinksDispatch implements Dispatchable {
  private context: DispatchContext;

  constructor(context: DispatchContext) {
    this.context = context;
  }

  matches(): boolean {
    return this.context.request.method === 'GET' && this.context.pathname === '/.well-known/assetlinks.json';
  }

  async handle(): Promise<Response> {
    return handleAndroidAssetLinks(this.context.env.ASSETLINK_HOST);
  }
}
