import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './src/db/schema/email-challenges.ts',
    './src/db/schema/batch-works.ts',
    './src/db/schema/device-codes.ts',
    './src/db/schema/oauth-client-info.ts',
    './src/db/schema/session-devices-source.ts',
    './src/db/schema/permissions.ts',
    './src/db/schema/organizations.ts',
    './src/db/schema/organization-members.ts',
    './src/db/schema/organization-invitations.ts',
    './src/db/schema/organization-teams.ts',
    './src/db/schema/organization-team-members.ts',
    './src/db/schema/tenant-github-installations.ts',
    './src/db/schema/tenant-types.ts',
    './src/db/schema/user-signing-keys.ts',
    './src/db/schema/tenant-linked-packages.ts',
  ],
  out: './drizzle/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
