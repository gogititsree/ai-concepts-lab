import { buildApp } from './app.js';
import { startHousekeeping } from './auth/housekeeping.js';
import { config } from './config.js';
import { closeDb } from './db/client.js';
import { checkSchemaDrift } from './db/schemaCheck.js';
import { installShutdownHandlers } from './plugins/shutdown.js';

const app = await buildApp({ config });

/**
 * Say out loud, once, whether this build's schema matches the database (M15 action item).
 *
 * `GET /health` already reports this as `checks.schema` and that is what fails the
 * deploy — but the first thing anyone reads during an incident is the platform's log,
 * and "column X is missing" in the boot lines turns a fifteen-minute hunt into a
 * fifteen-second one. It logs and continues rather than exiting: an instance that
 * refuses to boot answers nothing at all, and `/health` reporting `down` with the list
 * of missing columns is both strictly more diagnosable and enough to stop the deploy.
 */
try {
  const drift = await checkSchemaDrift(app.db);
  if (drift.ok) {
    app.log.info('schema check: the database has every column this build expects');
  } else {
    app.log.error(
      { missing: drift.missing },
      'schema check FAILED: this build and the database disagree. /health will report ' +
        'down. See docs/runbooks/db-migration-failed.md.',
    );
  }
} catch (error) {
  app.log.warn({ err: error }, 'schema check could not run');
}

// Background jobs belong to the *server*, not to `buildApp`: a test that builds an app
// must not silently acquire an hourly timer that keeps hitting a database it has since
// torn down.
const housekeeping = startHousekeeping(app);

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// SIGTERM is not an edge case here: it is how Render ends every deploy and every
// free-tier sleep. The ordering (stop timers, close the server so in-flight requests
// finish, *then* drain the pool) and the failure handling live in
// `plugins/shutdown.ts`, where they are unit-tested; this file only says what the parts
// are. See that module's header for why the pool drain matters on Neon.
installShutdownHandlers({
  log: app.log,
  closeServer: () => app.close(),
  closeDb,
  stopBackgroundWork: () => housekeeping.stop(),
  exit: (code) => process.exit(code),
});
