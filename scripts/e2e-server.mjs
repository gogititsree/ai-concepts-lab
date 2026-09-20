/**
 * Builds the app and starts the real server, for Playwright's `webServer`.
 *
 * "The real server" is the point: `node apps/api/dist/server.js` with
 * `NODE_ENV=production` is the same process the Docker image runs, serving the same
 * `apps/web/dist` bundle from the same origin. A Vite dev server would test a different
 * artifact — different bundler, different origin, no SPA fallback through Fastify — and
 * the E2E exists precisely to cover the seams a unit test cannot see.
 *
 * The build lives here rather than in the Playwright config's `command` string so that
 * `E2E_SKIP_BUILD=1` can turn it off. CI builds once in its own step (where a compile
 * error reports as a compile error, not as "webServer timed out"), then sets that flag.
 *
 * Every environment variable comes from the caller — see the `webServer.env` block in
 * `playwright.config.ts`, which is where the E2E's configuration is meant to be read.
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

if (process.env.E2E_SKIP_BUILD !== '1') {
  process.stdout.write('[e2e-server] building (set E2E_SKIP_BUILD=1 to skip)\n');
  // One shell string rather than (command, args, {shell:true}): the latter trips Node's
  // DEP0190 warning, and pnpm is a `.cmd` shim on Windows that needs a shell regardless.
  const build = spawnSync('pnpm build', { cwd: repoRoot, stdio: 'inherit', shell: true });
  if (build.status !== 0) {
    console.error('[e2e-server] build failed');
    process.exit(build.status ?? 1);
  }
}

process.stdout.write('[e2e-server] starting apps/api/dist/server.js\n');
const server = spawn(process.execPath, ['apps/api/dist/server.js'], {
  cwd: repoRoot,
  stdio: 'inherit',
});

// Playwright stops the web server by signalling this process; pass it on, so the API
// gets its normal SIGTERM shutdown (close the HTTP server, then drain the pool) instead
// of being orphaned and holding the E2E database open.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.kill(signal));
}
server.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
