import type { ReportedStep, ToolDefinition } from '@lab/shared';

import {
  MAX_LOG_CHARS,
  type HarnessAssistantReply,
  type HarnessMessage,
  type HarnessRunAgentResult,
} from './protocol';
import type { HarnessTools } from './workerTools';

/**
 * Compiling and running the learner's `runAgent`.
 *
 * This file is a **plain module with no worker API in it**, and that is deliberate.
 * `workers/harnessRunner.worker.ts` is a thin shell that translates messages into one
 * call to `runHarness` and translates the result back; everything that could be wrong —
 * the sandbox, the deadline, the step emission, the shape checking of what the learner
 * returned — lives here, where a Vitest process can call it directly. jsdom has no
 * `Worker`, so the alternative would have been no test at all for the part that matters.
 * See `apps/web/test/harnessCore.test.ts` and `apps/web/test/harnessWorkerProtocol.test.ts`.
 *
 * ## What the sandbox is, and what it is not
 *
 * `new Function(...)` is called **inside the worker**, never on the page. The learner's
 * source is never `eval`-ed on the main thread and never leaves the browser. Within the
 * worker the code is given an explicit set of names — `model`, `tools`, `maxIterations`
 * as arguments to `runAgent`, plus a `console` shim in scope — and a list of ambient
 * globals is shadowed to `undefined` so that reaching for `fetch` or `postMessage` is a
 * `TypeError` rather than a surprise.
 *
 * **It protects three things:**
 *  - *The page.* A `while (true) {}` in the learner's loop pins the worker's thread, not
 *    the UI thread. The page stays responsive, keeps its elapsed counter ticking, and can
 *    call `worker.terminate()` — which is the only thing that can actually stop a tight
 *    CPU loop, since nothing inside a realm can interrupt one.
 *  - *Server state.* The worker has no session and is never handed a URL or a request
 *    body. Every model call travels back to the page as a `model-request` message, and
 *    the page decides whether to make it. A runaway loop therefore costs the learner
 *    their own rate limit, and nothing else.
 *  - *Accidents.* Shadowing `fetch`, `importScripts`, `postMessage`, `indexedDB` and
 *    friends turns "I pasted something that phones home" from silent into loud.
 *
 * **It is not a security boundary.** The worker is same-origin with the page. Anyone who
 * wants out can write `Function('return this')()` or `(0, eval)('this')` and get the
 * worker's real global object back, complete with `fetch`, `indexedDB` and cookies. That
 * is not a hole to plug; it is what "same-origin" means, and plugging it would need a
 * cross-origin iframe or a `Worker` served from a separate origin, which this app does
 * not have and does not need — because **the hostile code here is the learner's own**,
 * typed into their own browser, with their own session. The threat model is mistakes,
 * not attackers. The moment this app let one person run another person's code, none of
 * the above would be enough and the loop would have to move to a real sandbox
 * (a separate origin, or a server-side container). Module 6's third lesson says so.
 */

/** The wall clock ran out. Distinguishable from the learner's own errors on purpose. */
export class HarnessTimeoutError extends Error {
  constructor(ms: number) {
    super(
      `Your loop was still running after ${Math.round(ms / 1000)} seconds and was stopped. ` +
        'If the model never returns a reply without tool calls, only your maximum-iteration ' +
        'cap can end the loop.',
    );
    this.name = 'HarnessTimeoutError';
  }
}

/** The learner's source did not compile, or did not define `runAgent`. */
export class HarnessCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessCompileError';
  }
}

/**
 * Ambient names shadowed inside the compiled function.
 *
 * Note what is absent: `eval` and `arguments`. A function with a `"use strict"` directive
 * may not have either as a parameter name — it is a `SyntaxError`, not a runtime one, so
 * including them would break every compile rather than block anything.
 */
const SHADOWED_GLOBALS = [
  'self',
  'globalThis',
  'window',
  'postMessage',
  'importScripts',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'indexedDB',
  'caches',
  'localStorage',
  'sessionStorage',
  'location',
  'navigator',
  'Worker',
  'SharedWorker',
] as const;

export interface SandboxConsole {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface SandboxModel {
  chat: (messages: HarnessMessage[], toolDefs: ToolDefinition[]) => Promise<HarnessAssistantReply>;
}

/**
 * `options` carries `toolDefs` as well as `maxIterations`.
 *
 * docs/04-curriculum.md writes the contract as `runAgent(model, tools, userMessage,
 * {maxIterations})`, and the extra field is an addition rather than a change: the
 * learner has to pass *something* as the second argument to `model.chat`, and the
 * alternatives were worse — a global, or hanging the definitions off the `tools` object
 * that their loop iterates. `model.chat` also falls back to the same definitions when
 * the second argument is omitted, so a loop written exactly to the doc still works.
 */
export type RunAgentFn = (
  model: SandboxModel,
  tools: HarnessTools,
  userMessage: string,
  options: { maxIterations: number; toolDefs: ToolDefinition[] },
) => Promise<unknown> | unknown;

/**
 * Compiles the learner's source into a callable `runAgent`.
 *
 * The body is wrapped rather than transformed: whatever they wrote is pasted verbatim
 * between a `"use strict"` directive and a `return runAgent`, so line numbers in a
 * stack trace stay close to what they see in the editor and a syntax error names the
 * construct they actually typed.
 */
export function compileRunAgent(code: string, consoleShim: SandboxConsole): RunAgentFn {
  let factory: (...args: unknown[]) => unknown;
  try {
    factory = new Function(
      ...SHADOWED_GLOBALS,
      'console',
      `"use strict";\n${code}\n;return typeof runAgent === 'function' ? runAgent : null;`,
    ) as (...args: unknown[]) => unknown;
  } catch (error) {
    throw new HarnessCompileError(
      `Your code did not compile: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const shadows = SHADOWED_GLOBALS.map(() => undefined);
  let produced: unknown;
  try {
    produced = factory(...shadows, consoleShim);
  } catch (error) {
    throw new HarnessCompileError(
      `Your code threw while it was being loaded: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof produced !== 'function') {
    throw new HarnessCompileError(
      'Your code must define a function called runAgent(model, tools, userMessage, options).',
    );
  }
  return produced as RunAgentFn;
}

// ------------------------------------------------------------------- the runner ----

/** Keeps one reported step comfortably under the API's 8 KB per-step ceiling. */
const MAX_STEP_JSON_CHARS = 3000;

function clamp(value: unknown): unknown {
  if (value === undefined) return null;
  let text: string;
  try {
    text = JSON.stringify(value) ?? 'null';
  } catch {
    return { note: 'this value could not be serialised as JSON' };
  }
  if (text.length <= MAX_STEP_JSON_CHARS) return value;
  return { truncated: true, preview: `${text.slice(0, MAX_STEP_JSON_CHARS)}…` };
}

/** `console.log(1, {a: 2})` → `1 {"a":2}`, truncated. Never throws on a cycle. */
export function formatLogArgs(args: unknown[]): string {
  const text = args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg) ?? String(arg);
      } catch {
        return '[unserialisable]';
      }
    })
    .join(' ');
  return text.length > MAX_LOG_CHARS ? `${text.slice(0, MAX_LOG_CHARS)}…` : text;
}

export interface RunHarnessInput {
  code: string;
  userMessage: string;
  maxIterations: number;
  tools: HarnessTools;
  toolDefs: ToolDefinition[];
  /**
   * Where a `model.chat` call actually goes: the scripted fake, or back to the page.
   * `iteration` is this runner's own counter, passed on so the server stamps the
   * `model_call` row it writes with the same number as the tool rows around it.
   */
  chat: (
    messages: HarnessMessage[],
    toolDefs: ToolDefinition[],
    iteration: number,
  ) => Promise<HarnessAssistantReply>;
  onLog: (level: 'log' | 'info' | 'warn' | 'error', text: string) => void;
  /** Reported to `POST /model/runs/:id/steps` in real mode; ignored in scripted mode. */
  onStep: (step: ReportedStep) => void;
  /** Soft deadline, checked before each model call and each tool call. */
  deadlineMs: number;
  /** Injectable clock, so a test can drive the deadline without waiting for it. */
  now?: () => number;
}

export interface HarnessRunOutput extends HarnessRunAgentResult {
  /** How many times the learner's loop called the model. */
  modelCalls: number;
}

/**
 * Runs one attempt of the learner's loop and returns what it produced.
 *
 * Throws on anything that went wrong — a compile error, a timeout, an exception from
 * inside their loop, or a return value of the wrong shape. The caller (the worker, or a
 * test) turns that into an `error` message with the count of model calls made so far,
 * because "your loop crashed on call 4" is a more useful failure than "your loop
 * crashed".
 */
export async function runHarness(input: RunHarnessInput): Promise<HarnessRunOutput> {
  const now = input.now ?? (() => Date.now());
  const startedAt = now();
  const counters = { modelCalls: 0, iteration: 0, steps: 0 };

  /**
   * The idempotency key for one reported step.
   *
   * Minted **here, where the step is created** — not in `useHarnessRunner` where it is
   * posted. That is the whole mechanism: a retry must resend the same step object with the
   * same id, so the server can recognise it and do nothing. Generating the id at post time
   * would give every retry a fresh one and turn `UNIQUE (run_id, client_step_id)` into an
   * expensive way to insert duplicates.
   *
   * A plain counter is enough because it only has to be unique within this run and stable
   * across retries of the same step, and a step is created exactly once. It deliberately
   * is *not* the step's position: the server owns `step_index`, and the two legitimately
   * differ because the server writes its own `model_call` rows into the same harness run.
   */
  const nextStepId = (): string => `c${++counters.steps}`;

  const checkDeadline = (): void => {
    if (now() - startedAt > input.deadlineMs) throw new HarnessTimeoutError(input.deadlineMs);
  };

  const consoleShim: SandboxConsole = {
    log: (...args) => input.onLog('log', formatLogArgs(args)),
    info: (...args) => input.onLog('info', formatLogArgs(args)),
    warn: (...args) => input.onLog('warn', formatLogArgs(args)),
    error: (...args) => input.onLog('error', formatLogArgs(args)),
  };

  const model: SandboxModel = {
    async chat(messages, toolDefs) {
      checkDeadline();
      counters.modelCalls += 1;
      counters.iteration += 1;
      // No `model_call` step from here: in real mode the page posts to `/model/chat`
      // with the run id and the *server* writes that row, with the latency and the token
      // counts it actually measured. Reporting it from the client too would double every
      // number in the rollup.
      return input.chat(
        Array.isArray(messages) ? messages : [],
        Array.isArray(toolDefs) ? toolDefs : input.toolDefs,
        counters.iteration,
      );
    },
  };

  /**
   * Every tool is wrapped so that calling it writes the two trace rows a tool call
   * produces, exactly as the server loop does. The learner writes `tools.calculator(...)`
   * and the trace fills in; they never report a step by hand, because a harness whose
   * observability depended on the author remembering to log is the failure mode Module
   * 6's fourth lesson is about.
   */
  const tools: HarnessTools = {};
  for (const [name, fn] of Object.entries(input.tools)) {
    tools[name] = (args: unknown) => {
      checkDeadline();
      const iteration = Math.max(1, counters.iteration);
      input.onStep({
        clientStepId: nextStepId(),
        kind: 'tool_call',
        iteration,
        toolName: name,
        toolArgs: clamp(args),
        isError: false,
      });
      const started = now();
      try {
        const result = fn(args);
        input.onStep({
          clientStepId: nextStepId(),
          kind: 'tool_result',
          iteration,
          toolName: name,
          toolResult: clamp(result),
          isError: false,
          latencyMs: Math.max(0, Math.round(now() - started)),
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        input.onStep({
          clientStepId: nextStepId(),
          kind: 'tool_result',
          iteration,
          toolName: name,
          toolResult: { error: message },
          isError: true,
          latencyMs: Math.max(0, Math.round(now() - started)),
        });
        throw error;
      }
    };
  }

  const runAgent = compileRunAgent(input.code, consoleShim);
  const returned = await runAgent(model, tools, input.userMessage, {
    maxIterations: input.maxIterations,
    toolDefs: input.toolDefs,
  });

  const result = validateResult(returned);
  input.onStep({
    clientStepId: nextStepId(),
    kind: 'final',
    iteration: Math.max(1, counters.iteration),
    content: result.finalText,
    isError: false,
  });
  return { ...result, modelCalls: counters.modelCalls };
}

/**
 * Checks the contract from lesson 2 and says which half is missing.
 *
 * Forgiving in one direction only: a missing `finalText` becomes `''` rather than an
 * error, because "your loop ran out of iterations and had nothing to say" is a legitimate
 * outcome the `max-iterations` check depends on. A missing `messages` is not forgiven —
 * two of the three checks read it, and silently substituting `[]` would turn a contract
 * mistake into a mysterious red tick somewhere else.
 */
export function validateResult(returned: unknown): HarnessRunAgentResult {
  if (typeof returned !== 'object' || returned === null || Array.isArray(returned)) {
    throw new Error(
      `runAgent must return an object like {finalText, messages}; it returned ${
        returned === undefined ? 'undefined' : JSON.stringify(returned)?.slice(0, 120)
      }.`,
    );
  }
  const record = returned as Record<string, unknown>;
  if (!Array.isArray(record.messages)) {
    throw new Error(
      'runAgent must return {finalText, messages} and `messages` must be the array of ' +
        'messages your loop built. Two of the three checks read it.',
    );
  }
  const finalText =
    typeof record.finalText === 'string'
      ? record.finalText
      : record.finalText === undefined || record.finalText === null
        ? ''
        : String(record.finalText);
  return { finalText, messages: record.messages as HarnessMessage[] };
}
