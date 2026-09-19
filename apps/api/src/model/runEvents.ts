import type { RunStep, RunSummary } from '@lab/shared';

/**
 * The in-process plumbing that lets `GET /model/runs/:id/events` watch a loop that is
 * running in the same Node process: a pub/sub bus, a registry of abort controllers so
 * cancel can reach a running loop, and a one-run-per-user semaphore.
 *
 * **Why in-process and not Redis / LISTEN-NOTIFY.** This app runs as a single container
 * (docs/01-architecture.md → Production topology) and local inference is serial anyway —
 * the semaphore below exists because two concurrent runs on one Ollama just queue behind
 * each other and both feel broken. The moment there are two instances, the SSE route's
 * *replay from Postgres* still works and only the live tail would need a shared bus. The
 * durable trace is in the database; this is only a latency optimisation over polling,
 * and saying so keeps the failure mode small and understood.
 *
 * Constructed per `modelRoutes` registration rather than as a module singleton, so two
 * apps in one test process (the `fake` one and the `none` one) do not share a semaphore.
 */

export type RunEvent = { type: 'step'; step: RunStep } | { type: 'end'; run: RunSummary };

type Listener = (event: RunEvent) => void;

export class RunEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(runId: string, listener: Listener): () => void {
    const set = this.listeners.get(runId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }

  publish(runId: string, event: RunEvent): void {
    const set = this.listeners.get(runId);
    if (!set) return;
    // Copied before iterating: an `end` listener unsubscribes itself, and mutating a Set
    // mid-iteration is the sort of bug that only shows up under load.
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        // A broken SSE socket must not take down the loop that is feeding it.
      }
    }
  }

  get listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

/**
 * Abort controllers for the loops currently running in this process.
 *
 * Cancel has two paths and both are needed: if the run is live here, aborting the
 * controller stops the inference and lets the loop write its own `cancelled` status and
 * trailing step. If it is not (another instance, or a process that has since restarted),
 * the route falls back to updating the row directly — which is why `cancel` in
 * `routes.ts` does not assume this map has an entry.
 */
export class RunControllerRegistry {
  private readonly controllers = new Map<string, AbortController>();

  register(runId: string): AbortController {
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    return controller;
  }

  abort(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  release(runId: string): void {
    this.controllers.delete(runId);
  }

  /** Called on server shutdown so in-flight loops stop instead of writing after close. */
  abortAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }
}

/**
 * One concurrent *agent* run per user.
 *
 * Not a fairness mechanism: local inference is serial, so a second run would not go any
 * faster, it would just make both traces take twice as long and make the elapsed counter
 * in the UI a lie. A 409 with `RUN_IN_PROGRESS` is a better answer than a queue nobody
 * can see. Harness runs are exempt — they are opened, not executed, and the model calls
 * inside them go through `/model/chat`, which has its own rate limit.
 */
export class RunSemaphore {
  private readonly active = new Map<string, string>();

  tryAcquire(userId: string, runId: string): { ok: true } | { ok: false; runningRunId: string } {
    const existing = this.active.get(userId);
    if (existing !== undefined) return { ok: false, runningRunId: existing };
    this.active.set(userId, runId);
    return { ok: true };
  }

  release(userId: string, runId: string): void {
    // Compare before deleting: a late release from a previous run must not free the slot
    // a newer run is holding.
    if (this.active.get(userId) === runId) this.active.delete(userId);
  }

  runningRunFor(userId: string): string | undefined {
    return this.active.get(userId);
  }
}
