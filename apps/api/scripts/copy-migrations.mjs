// tsc only emits .js, so the committed .sql migrations would never reach dist/ -- and the
// Docker image copies nothing but dist/. This runs after the TypeScript build so
// `node dist/db/migrate.js` finds `dist/db/migrations/` next to itself.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(root, 'src/db/migrations');
const to = resolve(root, 'dist/db/migrations');

if (!existsSync(from)) {
  console.error(`No migrations at ${from}`);
  process.exit(1);
}
// Removed first so a deleted migration cannot linger in an incremental build.
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
