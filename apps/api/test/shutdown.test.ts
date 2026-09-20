import { describe, expect, it, vi } from 'vitest';

import { createShutdownHandler, type ShutdownDeps } from '../src/plugins/shutdown.js';

/**
 * The SIGTERM path.
 *
 * This is the code that runs on every single deploy and never runs in a test suite that
 * does not deliberately call it — so it is the classic "worked until the day it
 * mattered" module. Driving the factory directly (no signals, no sockets, no database)
 * is what makes the failure branches reachable at all: the interesting ones are "the
 * HTTP server refused to close" and "something hung", neither of which can be provoked
 * from outside a real process.
 *
 * On Windows, note, `process.kill(pid, 'SIGTERM')` terminates a child immediately
 * without running its handlers, so a spawn-and-signal test would not even be possible on
 * this machine. One more reason the logic lives behind an injectable seam.
 */

function deps(overrides: Partial<ShutdownDeps> = {}) {
  const log = { info: vi.fn(), error: vi.fn() };
  const closeServer = vi.fn(async () => {});
  const closeDb = vi.fn(async () => {});
  const stopBackgroundWork = vi.fn();
  const exit = vi.fn();
  return {
    log,
    closeServer,
    closeDb,
    stopBackgroundWork,
    exit,
    ...overrides,
  } satisfies ShutdownDeps;
}

/** Lets the handler's internal async IIFE run to completion. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('createShutdownHandler', () => {
  it('stops timers, closes the server, then drains the pool, and exits 0', async () => {
    const order: string[] = [];
    const d = deps({
      stopBackgroundWork: () => order.push('timers'),
      closeServer: async () => {
        order.push('server');
      },
      closeDb: async () => {
        order.push('db');
      },
    });

    createShutdownHandler(d)('SIGTERM');
    await settle();

    // The order is the design: draining the pool before the server has stopped
    // accepting would fail the requests that are still in flight.
    expect(order).toEqual(['timers', 'server', 'db']);
    expect(d.exit).toHaveBeenCalledWith(0);
  });

  it('still drains the pool when closing the HTTP server fails', async () => {
    // The bug this prevents: `app.close().then(closeDb)` skips the drain entirely on a
    // rejection, and the process exits holding Neon connections open.
    const closeDb = vi.fn(async () => {});
    const d = deps({
      closeServer: vi.fn(async () => {
        throw new Error('server would not close');
      }),
      closeDb,
    });

    createShutdownHandler(d)('SIGTERM');
    await settle();

    expect(closeDb).toHaveBeenCalledOnce();
    expect(d.exit).toHaveBeenCalledWith(1);
    expect(d.log.error).toHaveBeenCalled();
  });

  it('reports a failing pool drain as a non-zero exit', async () => {
    const d = deps({
      closeDb: vi.fn(async () => {
        throw new Error('pool already gone');
      }),
    });

    createShutdownHandler(d)('SIGTERM');
    await settle();

    expect(d.exit).toHaveBeenCalledWith(1);
  });

  it('ignores a repeated signal instead of draining twice', async () => {
    const d = deps();
    const handler = createShutdownHandler(d);

    handler('SIGTERM');
    handler('SIGTERM');
    await settle();

    expect(d.closeDb).toHaveBeenCalledOnce();
    expect(d.log.info).toHaveBeenCalledWith(
      { signal: 'SIGTERM' },
      'shutdown already in progress; ignoring repeat signal',
    );
  });

  it('exits anyway when a step hangs past the deadline', async () => {
    // Render SIGKILLs after ~30 s; a clean-looking hang is indistinguishable from a
    // crash in the logs, so the process must give up on its own terms first.
    let fire: (() => void) | undefined;
    const d = deps({
      closeServer: () => new Promise<void>(() => {}), // never resolves
      timeoutMs: 15_000,
      setTimeoutFn: ((callback: () => void) => {
        fire = callback;
        return { unref: () => {} };
      }) as unknown as typeof setTimeout,
    });

    createShutdownHandler(d)('SIGTERM');
    await settle();
    expect(d.exit).not.toHaveBeenCalled();

    fire?.();
    expect(d.exit).toHaveBeenCalledWith(1);
  });

  it('survives a throwing stopBackgroundWork', async () => {
    const d = deps({
      stopBackgroundWork: () => {
        throw new Error('clearInterval exploded');
      },
    });

    createShutdownHandler(d)('SIGTERM');
    await settle();

    expect(d.closeServer).toHaveBeenCalledOnce();
    expect(d.closeDb).toHaveBeenCalledOnce();
    expect(d.exit).toHaveBeenCalledWith(1);
  });
});
