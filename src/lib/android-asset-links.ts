import { z } from 'zod';

const androidDeeplinkInfoSchema = z.record(
  z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/),
  z.object({
    fingerprints: z.array(z.string().regex(/^(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/)).min(1),
    protocols: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/$/)).min(1),
  }),
).refine((value) => Object.keys(value).length > 0, 'At least one Android app must be configured.');

function configurationError(reason: string): Response {
  return Response.json(
    { error: 'android_deeplink_info_invalid', reason },
    { status: 503, headers: { 'cache-control': 'no-store' } },
  );
}

export function handleAndroidAssetLinks(rawConfig: string | undefined): Response {
  if (!rawConfig) {
    return configurationError('The ANDROID_DEEPLINK_INFO GitHub Actions variable is not configured.');
  }

  let config: unknown;
  try {
    config = JSON.parse(rawConfig);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Invalid JSON.';
    return configurationError(`ANDROID_DEEPLINK_INFO must contain valid JSON: ${detail}`);
  }

  const parsed = androidDeeplinkInfoSchema.safeParse(config);
  if (!parsed.success) {
    const reason = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
    return configurationError(`ANDROID_DEEPLINK_INFO has an invalid shape: ${reason}`);
  }

  const links = Object.entries(parsed.data).map(([packageName, app]) => ({
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: packageName,
      sha256_cert_fingerprints: app.fingerprints,
    },
  }));

  return Response.json(links, { headers: { 'cache-control': 'public, max-age=300' } });
}
