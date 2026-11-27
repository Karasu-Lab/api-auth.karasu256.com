import { describe, expect, it } from 'vitest';
import { buildLinkableProviderClients } from '../src/lib/linkable-providers';

function envWith(vars: Record<string, string>): Env {
  return vars as unknown as Env;
}

describe('buildLinkableProviderClients', () => {
  it('lists the configured social providers with their client ids and icon paths', () => {
    const clients = buildLinkableProviderClients(
      envWith({
        GOOGLE_CLIENT_ID: 'google-client-id',
        GOOGLE_CLIENT_SECRET: 'google-secret',
        GH_CLIENT_ID: 'github-client-id',
        GH_CLIENT_SECRET: 'github-secret',
      })
    );
    expect(clients).toEqual([
      { providerId: 'google', clientId: 'google-client-id', iconPath: '/api/assets/oauth/providers/google' },
      { providerId: 'github', clientId: 'github-client-id', iconPath: '/api/assets/oauth/providers/github' },
      { providerId: 'minecraft', clientId: null, iconPath: '/api/assets/oauth/providers/minecraft' },
    ]);
  });

  it('derives the xbox client from the microsoft credentials', () => {
    const clients = buildLinkableProviderClients(
      envWith({
        MICROSOFT_CLIENT_ID: 'microsoft-client-id',
        MICROSOFT_CLIENT_SECRET: 'microsoft-secret',
      })
    );
    expect(clients).toEqual([
      { providerId: 'microsoft', clientId: 'microsoft-client-id', iconPath: '/api/assets/oauth/providers/microsoft' },
      { providerId: 'xbox', clientId: 'microsoft-client-id', iconPath: '/api/assets/oauth/providers/xbox' },
      { providerId: 'minecraft', clientId: null, iconPath: '/api/assets/oauth/providers/minecraft' },
    ]);
  });

  it('uses the primary google client id when additional ids are configured', () => {
    const clients = buildLinkableProviderClients(
      envWith({
        GOOGLE_CLIENT_ID: 'google-primary',
        GOOGLE_CLIENT_SECRET: 'google-secret',
        GOOGLE_ADDITIONAL_CLIENT_IDS: '["google-secondary"]',
      })
    );
    expect(clients[0]).toEqual({ providerId: 'google', clientId: 'google-primary', iconPath: '/api/assets/oauth/providers/google' });
  });
});
