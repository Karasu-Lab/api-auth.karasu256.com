import { z } from 'zod';

const flagResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    value: z.boolean(),
    type: z.literal('boolean'),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

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
