import { buildApp } from './app.js';
import { startHousekeeping } from './auth/housekeeping.js';
import { config } from './config.js';
import { closeDb } from './db/client.js';
import { installShutdownHandlers } from './plugins/shutdown.js';

const app = await buildApp({ config });

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
