import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: [
    '../../packages/db/src/schema/device-codes.ts',
    '../../packages/db/src/schema/oauth-client-info.ts',
    '../../packages/db/src/schema/session-devices-source.ts',
    '../../packages/db/src/schema/permissions.ts',
    '../../packages/db/src/schema/organizations.ts',
    '../../packages/db/src/schema/organization-members.ts',
    '../../packages/db/src/schema/organization-invitations.ts',
    '../../packages/db/src/schema/organization-teams.ts',
    '../../packages/db/src/schema/organization-team-members.ts',
    '../../packages/db/src/schema/tenant-github-installations.ts',
    '../../packages/db/src/schema/user-signing-keys.ts',
    '../../packages/db/src/schema/signing-key-authorizations.ts',
    '../../packages/db/src/schema/tenant-npm-configurations.ts',
    '../../packages/db/src/schema/tenant-linked-packages.ts',
  ],
  out: './drizzle/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
