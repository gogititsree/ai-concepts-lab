import { buildApp } from './app.js';
import { config } from './config.js';
import { closeDb } from './db/client.js';

const app = await buildApp({ config });

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'shutting down');
    // Close the HTTP server first so in-flight requests finish, then drain the pool:
    // ending it earlier would fail those requests instead of letting them complete.
    void app
      .close()
      .then(() => closeDb())
      .then(() => process.exit(0));
  });
}
