async function derivePassword(secret: string, uid: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(uid));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Ensures a Neon Auth account exists for the given user, signing up on first
 * visit. The password is derived with HMAC-SHA256 from `AUTH_SECRET` and the
 * user id, so it equals the value `deriveNeonAuthPassword` produced before the
 * move and is never exposed to clients.
 */
export async function syncUserToNeonAuth(env: Env, user: { id: string; email?: string | null; name?: string | null }): Promise<void> {
  if (!user.email) return;

  const password = await derivePassword(env.AUTH_SECRET, user.id);
  const headers = { 'Content-Type': 'application/json', Origin: env.BETTER_AUTH_URL };
  const post = (path: string, body: unknown) => fetch(`${env.NEON_AUTH_BASE_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

  const signIn = await post('/sign-in/email', { email: user.email, password });
  if (signIn.ok) return;

  const signUp = await post('/sign-up/email', { email: user.email, password, name: user.name ?? user.email });
  if (!signUp.ok) throw new Error(`Neon Auth sign-up failed: ${signUp.status}`);
}
