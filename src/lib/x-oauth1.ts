export interface XConsumer {
  key: string;
  secret: string;
}

function percentEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function hmacSha1Base64(key: string, message: string) {
  const cryptoKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message)));
  return btoa(String.fromCharCode(...signature));
}

export async function signXRequest(
  consumer: XConsumer,
  method: 'GET' | 'POST',
  url: string,
  options: { token?: string; tokenSecret?: string; extraOAuthParams?: Record<string, string> } = {}
) {
  const target = new URL(url);
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumer.key,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
    ...(options.token ? { oauth_token: options.token } : {}),
    ...options.extraOAuthParams,
  };

  const signedParams = [...Object.entries(oauthParams), ...target.searchParams.entries()]
    .map(([name, value]) => [percentEncode(name), percentEncode(value)] as const)
    .sort(([nameA, valueA], [nameB, valueB]) => (nameA === nameB ? (valueA < valueB ? -1 : 1) : nameA < nameB ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const baseUrl = `${target.origin}${target.pathname}`;
  const base = [method, percentEncode(baseUrl), percentEncode(signedParams)].join('&');
  const signature = await hmacSha1Base64(`${percentEncode(consumer.secret)}&${percentEncode(options.tokenSecret ?? '')}`, base);

  const header = Object.entries({ ...oauthParams, oauth_signature: signature })
    .map(([name, value]) => `${percentEncode(name)}="${percentEncode(value)}"`)
    .join(', ');
  return `OAuth ${header}`;
}

async function postForm(consumer: XConsumer, url: string, options: Parameters<typeof signXRequest>[3]) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: await signXRequest(consumer, 'POST', url, options) },
  }).catch(() => null);
  if (!response?.ok) {
    const { origin, pathname } = new URL(url);
    const body = await response?.text().catch(() => null);
    console.error(JSON.stringify({ level: 'error', kind: 'x-oauth1', url: `${origin}${pathname}`, status: response?.status ?? null, body }));
    return null;
  }
  return new URLSearchParams(await response.text());
}

export async function fetchXRequestToken(consumer: XConsumer, callbackUrl: string) {
  const params = await postForm(consumer, 'https://api.x.com/oauth/request_token', { extraOAuthParams: { oauth_callback: callbackUrl } });
  const token = params?.get('oauth_token');
  const tokenSecret = params?.get('oauth_token_secret');
  if (!token || !tokenSecret || params?.get('oauth_callback_confirmed') !== 'true') return null;
  return { token, tokenSecret };
}

export function xAuthenticateUrl(requestToken: string) {
  const url = new URL('https://api.x.com/oauth/authenticate');
  url.searchParams.set('oauth_token', requestToken);
  return url;
}

export async function fetchXAccessToken(consumer: XConsumer, requestToken: string, requestTokenSecret: string, verifier: string) {
  const url = new URL('https://api.x.com/oauth/access_token');
  url.searchParams.set('oauth_verifier', verifier);
  const params = await postForm(consumer, url.toString(), { token: requestToken, tokenSecret: requestTokenSecret });
  const token = params?.get('oauth_token');
  const tokenSecret = params?.get('oauth_token_secret');
  if (!token || !tokenSecret) return null;
  return { token, tokenSecret };
}
