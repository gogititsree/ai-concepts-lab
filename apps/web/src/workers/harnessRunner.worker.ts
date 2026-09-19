/// <reference lib="webworker" />

import type { HarnessScenarioId } from '@lab/shared';

import { runHarness } from '../features/exercises/harness/harnessCore';
import {
  type HarnessAssistantReply,
  type HarnessMessage,
  type PageToWorkerMessage,
  type StartMessage,
  type WorkerToPageMessage,
} from '../features/exercises/harness/protocol';
import { runScriptedScenario } from '../features/exercises/harness/scriptedRunner';
import {
  createWorkerTools,
  HARNESS_TOOL_DEFINITIONS,
} from '../features/exercises/harness/workerTools';

/**
 * The Web Worker that runs the learner's `runAgent` (M11, decision 4 in
 * `docs/07-open-decisions.md`).
 *
 * **This file is deliberately thin.** It owns the message protocol and nothing else:
 * one `start` in, `model-request` / `step` / `log` out, `done` or `error` at the end.
 * Every decision worth testing — how the code is compiled, what the sandbox contains,
 * when the deadline fires, which steps are emitted — lives in
 * `features/exercises/harness/harnessCore.ts`, because jsdom has no `Worker` and a test
 * cannot reach anything that only exists in here. What *is* only in here is tested
 * against a stub `Worker` from the page's side, in
 * `apps/web/test/harnessWorkerProtocol.test.ts`.
 *
 * **Where the learner's code runs, and what that buys.** `new Function` is called here,
 * in this worker, on this thread. Never on the page. A `while (true) {}` therefore pins
 * *this* thread: the UI keeps painting, the elapsed counter keeps counting, and the
 * cancel button still works — because the only thing in a browser that can stop a tight
 * synchronous loop is `worker.terminate()` from the outside, and the page has that.
 * Read the long comment at the top of `harnessCore.ts` for what the sandbox does not
 * protect against; the short version is that it is a boundary against *mistakes*, not
 * against an attacker, and the code in question is the learner's own.
 *
 * **The worker has no credentials.** It cannot fetch. In real mode it asks the page to
 * make each model call (`model-request`) and waits for the answer (`model-response`), and
 * it asks the page to file each step (`step`). So the worst a runaway loop can do to the
 * server is ask for one more model call than it should, which the page counts and the
 * API rate-limits.
 */

const ctx = self as unknown as DedicatedWorkerGlobalScope;

const post = (message: WorkerToPageMessage): void => {
  ctx.postMessage(message);
};

/** One in-flight `model-request` at a time, keyed so a stale reply cannot resolve a new call. */
interface Pending {
  id: number;
  resolve: (reply: HarnessAssistantReply) => void;
  reject: (error: Error) => void;
}

let pending: Pending | null = null;
let nextRequestId = 1;
let cancelled = false;

/** Thrown into the learner's loop when the page cancels. Their `await` rejects; we stop. */
class CancelledError extends Error {
  constructor() {
    super('The run was cancelled.');
    this.name = 'CancelledError';
  }
}

/**
 * A model call that travels through the page.
 *
 * The promise is resolved by the `model-response` handler below. There is no timeout
 * here on purpose: the page owns the wall clock (it knows whether this is a 60-second
 * scripted budget or a five-minute real one) and it enforces it by terminating the
 * worker, which is the only enforcement that works against every kind of stuck.
 */
function requestModelCall(
  messages: HarnessMessage[],
  toolDefs: StartMessage['toolDefs'],
  iteration: number,
): Promise<HarnessAssistantReply> {
  if (cancelled) return Promise.reject(new CancelledError());
  const id = nextRequestId;
  nextRequestId += 1;
  return new Promise<HarnessAssistantReply>((resolve, reject) => {
    pending = { id, resolve, reject };
    post({ type: 'model-request', id, messages, toolDefs, iteration });
  });
}

async function handleStart(message: StartMessage): Promise<void> {
  cancelled = false;

  if (message.mode === 'scripted') {
    // The scripted path never touches the page: the fake model, the tools and the
    // checks' raw material are all in this thread, which is what makes the three checks
    // reproducible with Ollama absent.
    const outcome = await runScriptedScenario({
      scenario: message.scenario as HarnessScenarioId,
      code: message.code,
      maxIterations: message.maxIterations,
      onLog: (level, text) => post({ type: 'log', level, text }),
      deadlineMs: message.deadlineMs,
    });
    if (outcome.ok) {
      post({
        type: 'done',
        finalText: outcome.finalText,
        messages: outcome.messages,
        modelCalls: outcome.modelCalls,
      });
    } else {
      post({
        type: 'error',
        message: outcome.error ?? 'The scripted run failed.',
        stack: null,
        modelCalls: outcome.modelCalls,
        messages: [],
      });
    }
    return;
  }

  // ------------------------------------------------------------------ real mode ----

  const names = message.toolDefs.map((tool) => tool.name);
  const tools = createWorkerTools(
    names.length > 0 ? names : Object.keys(HARNESS_TOOL_DEFINITIONS),
    { now: () => new Date() },
  );
  let modelCalls = 0;

  try {
    const output = await runHarness({
      code: message.code,
      userMessage: message.userMessage,
      maxIterations: message.maxIterations,
      tools,
      toolDefs: message.toolDefs,
      chat: (messages, toolDefs, iteration) => {
        modelCalls += 1;
        return requestModelCall(messages, toolDefs, iteration);
      },
      onLog: (level, text) => post({ type: 'log', level, text }),
      onStep: (step) => post({ type: 'step', step }),
      deadlineMs: message.deadlineMs,
    });
    post({
      type: 'done',
      finalText: output.finalText,
      messages: output.messages,
      modelCalls: output.modelCalls,
    });
  } catch (error) {
    post({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? (error.stack ?? null) : null,
      modelCalls,
      messages: [],
    });
  }
}

ctx.addEventListener('message', (event: MessageEvent<PageToWorkerMessage>) => {
  const message = event.data;

  if (message.type === 'start') {
    // Not awaited: `handleStart` owns its own errors, and an unhandled rejection here
    // would be reported as a worker error with no context instead of an `error` message
    // the learner can read.
    void handleStart(message);
    return;
  }

  if (message.type === 'model-response') {
    const waiting = pending;
    // A response for a call we are not waiting on is dropped rather than resolved: after
    // a cancel the ids no longer line up, and resolving the wrong call would hand the
    // learner's loop an answer to a question it did not ask.
    if (!waiting || waiting.id !== message.id) return;
    pending = null;
    if (message.ok && message.reply) waiting.resolve(message.reply);
    else waiting.reject(new Error(message.error ?? 'The model call failed.'));
    return;
  }

  if (message.type === 'cancel') {
    cancelled = true;
    const waiting = pending;
    pending = null;
    // Rejecting unsticks a loop that is waiting on a model call. A loop that is *not*
    // waiting on anything — a tight `for(;;)` with no `await` — cannot be reached from
    // here at all, and the page's `terminate()` is what stops that one.
    waiting?.reject(new CancelledError());
  }
});
