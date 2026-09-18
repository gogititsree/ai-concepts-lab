import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration. Only the CLI reads this file (`generate`, `studio`,
 * `check`); the application never imports it, and the running app never introspects the
 * database — migrations are plain SQL committed to the repo and applied by
 * `src/db/migrate.ts`.
 *
 * Migrations live under `src/` rather than at the package root so that one `COPY
 * apps/api/dist` in the Dockerfile ships them (the build step copies the folder into
 * `dist/db/migrations`).
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // Only `studio`/`push`/`check` connect. Generation is purely offline, so the local
    // compose credentials are a safe fallback for a developer who has not exported one.
    url: process.env.DATABASE_URL ?? 'postgres://lab:lab@localhost:5432/lab',
  },
  // Print the SQL it is about to run and ask before anything destructive.
  verbose: true,
  strict: true,
});
