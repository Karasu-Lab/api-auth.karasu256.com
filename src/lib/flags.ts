import { flagResponseSchema } from '@karasu-lab/types/server';

export async function isMinecraftAuthEnabled(env: Env): Promise<boolean> {
  try {
    const response = await fetch(new URL('/api/flags/useMinecraftAuth', env.FEATURE_FLAGS_API_URL), {
      headers: { Origin: env.FEATURE_FLAGS_ORIGIN },
    });
    const body = flagResponseSchema.parse(await response.json());
    return body.ok ? body.value : false;
  } catch {
    return false;
  }
}
