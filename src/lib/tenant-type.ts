import { createDb } from '@karasu-lab/db/create-db';
import { tenantTypes } from '@karasu-lab/db/schema';
import { createTenantBodySchema } from '@karasu-lab/types/shared';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { waitUntil } from 'cloudflare:workers';
import { z } from 'zod';

const CREATE_ORGANIZATION_PATH = '/organization/create';

const createdOrganizationSchema = z.object({ id: z.string().min(1) });

export function tenantTypePlugin(env: Env) {
  return {
    id: 'tenant-type',
    hooks: {
      before: [
        {
          matcher: (context: { path?: string }) => context.path === CREATE_ORGANIZATION_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const parsed = createTenantBodySchema.safeParse(ctx.body);
            if (!parsed.success) throw new APIError('BAD_REQUEST', { message: 'tenant_type_required' });
          }),
        },
      ],
      after: [
        {
          matcher: (context: { path?: string }) => context.path === CREATE_ORGANIZATION_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const created = createdOrganizationSchema.safeParse(ctx.context.returned);
            const body = createTenantBodySchema.safeParse(ctx.body);
            if (!created.success || !body.success) return;
            const db = createDb(env.DATABASE_URL);
            try {
              await db
                .insert(tenantTypes)
                .values({ tenantId: created.data.id, type: body.data.type })
                .onConflictDoNothing();
            } finally {
              waitUntil(db.$client.end());
            }
          }),
        },
      ],
    },
  };
}
