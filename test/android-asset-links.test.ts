import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAndroidAssetLinks } from '../src/lib/android-asset-links';

const statements = [
  {
    relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
    target: {
      namespace: 'android_app',
      package_name: 'com.karasu256.karasulab',
      sha256_cert_fingerprints: ['00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF'],
    },
  },
];

describe('Android Digital Asset Links', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rewrites to the asset links of the ASSETLINK_HOST host', async () => {
    const fetchMock = vi.fn(async () => Response.json(statements));
    vi.stubGlobal('fetch', fetchMock);

    const response = await handleAndroidAssetLinks('api.example.test');

    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/asset-links');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await response.json()).toEqual(statements);
  });

  it('returns a diagnostic when ASSETLINK_HOST is not configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await handleAndroidAssetLinks(undefined);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: 'assetlink_host_not_configured',
      reason: expect.stringContaining('ASSETLINK_HOST'),
    });
  });

  it('responds 502 when the asset link host fails or is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    const failed = await handleAndroidAssetLinks('api.example.test');
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: 'upstream_error' });

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    const unreachable = await handleAndroidAssetLinks('api.example.test');
    expect(unreachable.status).toBe(502);
    expect(await unreachable.json()).toMatchObject({ error: 'upstream_unreachable' });
  });
});
