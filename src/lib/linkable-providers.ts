import { waitUntil } from 'cloudflare:workers';
import { createSocialProviders } from './social-providers';
import {
  LinkableProviderGetRepository,
  LinkableProviderSetRepository,
  type LinkableProviderClient,
} from './redis/linkable-provider-repositories';

export type { LinkableProviderClient };

export function providerIconPath(providerId: string): string {
  return `/api/assets/oauth/providers/${providerId}`;
}

function firstClientId(clientId: string | string[] | undefined): string | null {
  if (Array.isArray(clientId)) return clientId[0] ?? null;
  return clientId ?? null;
}

export function buildLinkableProviderClients(env: Env): LinkableProviderClient[] {
  const social = createSocialProviders(env) as Record<string, { clientId?: string | string[] }>;
  const clients: LinkableProviderClient[] = Object.entries(social).map(([providerId, config]) => ({
    providerId,
    clientId: firstClientId(config.clientId),
    iconPath: providerIconPath(providerId),
  }));
  if (social.microsoft) {
    clients.push({ providerId: 'xbox', clientId: firstClientId(social.microsoft.clientId), iconPath: providerIconPath('xbox') });
  }
  clients.push({ providerId: 'minecraft', clientId: null, iconPath: providerIconPath('minecraft') });
  return clients;
}

export async function getLinkableProviderClients(env: Env): Promise<LinkableProviderClient[]> {
  const cached = await new LinkableProviderGetRepository(env).get().catch(() => null);
  if (cached) return cached;
  const clients = buildLinkableProviderClients(env);
  await new LinkableProviderSetRepository(env).set(clients).catch(() => undefined);
  return clients;
}

let refreshed = false;

export function refreshLinkableProviderClients(env: Env): void {
  if (refreshed) return;
  refreshed = true;
  waitUntil(
    new LinkableProviderSetRepository(env)
      .set(buildLinkableProviderClients(env))
      .catch(() => undefined)
  );
}
