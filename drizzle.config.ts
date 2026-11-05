import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: ['../../packages/db/src/schema/device-codes.ts', '../../packages/db/src/schema/oauth-client-info.ts'],
  out: './drizzle/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
