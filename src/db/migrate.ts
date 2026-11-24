/// <reference types="vite/client" />
import type { PgDialect, PgSession } from 'drizzle-orm/pg-core';
import { createDb } from './create-db';

const files = import.meta.glob<string>('../../drizzle/migrations/*.sql', { query: '?raw', import: 'default', eager: true });
const journalFiles = import.meta.glob<string>('../../drizzle/migrations/meta/_journal.json', { query: '?raw', import: 'default', eager: true });

/**
 * Applies the bundled drizzle migrations through the given connection string
 * (the Hyperdrive binding's). Workers have no filesystem for drizzle-orm's
 * `migrate()` to read, so the migration metadata is built from the bundled
 * files and applied by the same dialect migrator.
 */
export async function applyMigrations(url: string): Promise<void> {
  const db = createDb(url);
  const journal = JSON.parse(Object.values(journalFiles)[0]!) as { entries: { tag: string; when: number }[] };
  const migrations = await Promise.all(
    journal.entries.map(async ({ tag, when }) => {
      const source = files[`../../drizzle/migrations/${tag}.sql`]!;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
      return {
        sql: source.split('--> statement-breakpoint'),
        folderMillis: when,
        hash: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
        bps: true,
      };
    })
  );
  const { dialect, session } = db as unknown as { dialect: PgDialect; session: PgSession };
  await dialect.migrate(migrations, session, { migrationsFolder: '' });
}
