/**
 * Graceful shutdown (M13).
 *
 * Render stops an instance by sending **SIGTERM** and then `SIGKILL`ing it about 30
 * seconds later; every deploy, every scale-down and every free-tier sleep goes through
 * this path, several times a day. Three things have to happen in order, and the order is
 * the whole design:
 *
 *   1. stop background timers, so nothing new starts;
 *   2. `app.close()`, which stops accepting connections and lets in-flight requests
 *      finish — draining the pool first would fail exactly those requests;
 *   3. `closeDb()`, which ends the postgres.js pool.
 *
 * Step 3 is not cosmetic on Neon. A pooled Neon endpoint holds server-side state per
 * client connection; a process that vanishes leaves connections for the pooler to time
 * out, and on a free plan with a small connection budget, a redeploy loop can leave the
 * new instance fighting the old one's corpses for slots. Ending the pool sends a proper
 * terminate for each.
 *
 * Why it is a module of its own rather than eight lines in `server.ts`: those eight
 * lines have three failure modes that are invisible until the day they matter — a
 * rejected `close()` skipping the pool drain, a second SIGTERM re-entering the handler,
 * and a hang with no upper bound — and none of them is testable inside an entrypoint
 * that also calls `listen()`. Here the decision logic is a pure factory over injected
 * dependencies, and `test/shutdown.test.ts` drives all four paths with no signals, no
 * sockets and no database.
 */

export interface ShutdownLogger {
  info(obj: object, message: string): void;
  error(obj: object, message: string): void;
}

export interface ShutdownDeps {
  log: ShutdownLogger;
  /** `app.close()`. Stops the listener and runs Fastify's own onClose hooks. */
  closeServer: () => Promise<void>;
  /** `closeDb()` from `db/client.ts`. */
  closeDb: () => Promise<void>;
  /** Timers and the like; must not throw. */
  stopBackgroundWork?: () => void;
  exit: (code: number) => void;
  /**
   * Hard deadline. 15 s sits inside Render's ~30 s grace period with room for the exit
   * log line to flush: a shutdown that overruns the platform's patience is killed with
   * `SIGKILL` and looks, in the logs, exactly like a crash.
   */
  timeoutMs?: number;
  /** Injected so the timeout path is testable without waiting 15 real seconds. */
  setTimeoutFn?: typeof setTimeout;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;

/**
 * Builds the signal handler.
 *
 * Returns a plain function so the caller decides which signals it is attached to, and so
 * a test can simply call it.
 */
export function createShutdownHandler(deps: ShutdownDeps): (signal: string) => void {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const schedule = deps.setTimeoutFn ?? setTimeout;
  let shuttingDown = false;

  return function shutdown(signal: string): void {
    if (shuttingDown) {
      // Docker and Render both re-send the signal if the process lingers, and a
      // container orchestrator retrying SIGTERM must not start a second drain on top of
      // the first — that is how you get `sql.end()` racing itself.
      deps.log.info({ signal }, 'shutdown already in progress; ignoring repeat signal');
      return;
    }
    shuttingDown = true;
    deps.log.info({ signal, timeoutMs }, 'shutting down');

    // Armed before any awaiting, so a hang anywhere below still terminates. `unref()`
    // means the timer itself never keeps the process alive once the clean path wins.
    const timer = schedule(() => {
      deps.log.error({ signal, timeoutMs }, 'shutdown timed out; exiting anyway');
      deps.exit(1);
    }, timeoutMs);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }

    void (async () => {
      let code = 0;
      try {
        deps.stopBackgroundWork?.();
      } catch (error) {
        deps.log.error({ err: error }, 'failed to stop background work');
        code = 1;
      }

      // Each step is tried independently. The point of the `try` around `closeServer` is
      // that a failure there must not skip `closeDb` — leaking database connections
      // because the HTTP server was unhappy is precisely the coupling to avoid.
      try {
        await deps.closeServer();
      } catch (error) {
        deps.log.error({ err: error }, 'error closing the HTTP server');
        code = 1;
      }

      try {
        await deps.closeDb();
      } catch (error) {
        deps.log.error({ err: error }, 'error closing the database pool');
        code = 1;
      }

      clearTimeout(timer as Parameters<typeof clearTimeout>[0]);
      deps.log.info({ signal, code }, 'shutdown complete');
      deps.exit(code);
    })();
  };
}

/** Attaches the handler to the signals a container runtime actually sends. */
export function installShutdownHandlers(deps: ShutdownDeps): (signal: string) => void {
  const handler = createShutdownHandler(deps);
  // SIGTERM: Render and `docker stop`. SIGINT: Ctrl-C in development.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => handler(signal));
  }
  return handler;
}
