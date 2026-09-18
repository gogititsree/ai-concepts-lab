import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { config } from '../config.js';
import { isMainModule } from '../lib/isMainModule.js';
import { createDbClient, type Db } from './client.js';

/**
 * Applies the committed SQL migrations.
 *
 * Runnable two ways, deliberately: `tsx src/db/migrate.ts` in development and
 * `node dist/db/migrate.js` in the Docker image (Render runs the latter as its pre-deploy
 * command). The folder is resolved from `import.meta.url`, so it is `src/db/migrations`
 * under tsx and `dist/db/migrations` in the image — `pnpm --filter api build` copies the
 * .sql files across, because tsc only emits .js.
 */
const here = dirname(fileURLToPath(import.meta.url));
export const migrationsFolder = resolve(here, 'migrations');

export async function runMigrations(db: Db): Promise<void> {
  // The migrator wraps each file in a transaction and records what it applied in
  // `drizzle.__drizzle_migrations`, so a second run is a no-op rather than an error.
  await migrate(db, { migrationsFolder });
}

async function main(): Promise<void> {
  // One connection: a migration run is strictly serial, and extra idle sockets are pure
  // cost on a platform that counts connections (Neon).
  const client = createDbClient(config.DATABASE_URL, { max: 1 });
  const redacted = config.DATABASE_URL.replace(/\/\/[^@]*@/, '//***@');
  try {
    console.log(`Applying migrations from ${migrationsFolder} to ${redacted}`);
    await runMigrations(client.db);
    console.log('Migrations up to date.');
  } finally {
    await client.close();
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  });
}
