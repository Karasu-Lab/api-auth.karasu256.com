import { z } from 'zod';

// The same evaluation response @karasu-lab/flags-sdk's createApiFlags
// parses on the accounts side. The SDK's server entry is bound to
// Next.js and React, so this worker evaluates the flag through the
// flags API directly, with the same request and response shape.
const flagResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    value: z.boolean(),
    type: z.literal('boolean'),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

/**
 * Whether Minecraft authentication is enabled by the `useMinecraftAuth`
 * flag on flagship. A flag that cannot be evaluated keeps Minecraft
 * authentication off, so a failing flag read never starts a Minecraft
 * profile resolution that is expected to fail.
 */
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
