export async function handleAndroidAssetLinks(assetlinkHost: string | undefined): Promise<Response> {
  if (!assetlinkHost) {
    return Response.json(
      { error: 'assetlink_host_not_configured', reason: 'The ASSETLINK_HOST GitHub Actions variable is not configured.' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
  try {
    const res = await fetch(`https://${assetlinkHost}/asset-links`);
    if (!res.ok) {
      return Response.json({ error: 'upstream_error' }, { status: 502, headers: { 'cache-control': 'no-store' } });
    }
    return Response.json(await res.json(), { headers: { 'cache-control': 'public, max-age=300' } });
  } catch {
    return Response.json({ error: 'upstream_unreachable' }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
}
