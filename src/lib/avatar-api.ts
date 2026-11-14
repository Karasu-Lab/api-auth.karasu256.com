import { z } from 'zod';

const storedAvatarSchema = z.object({ url: z.url() });

export async function storeProviderAvatar(env: Env, userId: string, providerId: string, source: string): Promise<string> {
  const res = await fetch(
    `${env.API_URL}/internal/avatars/users/${encodeURIComponent(userId)}/providers/${encodeURIComponent(providerId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.INTERNAL_API_SECRET}` },
      body: JSON.stringify({ source }),
      cache: 'no-store',
    }
  );
  if (!res.ok) throw new Error(`api.karasu256.com responded ${res.status} for ${res.url}`);
  return storedAvatarSchema.parse(await res.json()).url;
}
