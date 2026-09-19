import type { HarnessScenarioId, ReportedStep, ToolDefinition } from '@lab/shared';

/**
 * The contract between the page and `workers/harnessRunner.worker.ts`.
 *
 * It lives in its own file, imported by both sides, because a worker boundary is a
 * *serialisation* boundary: nothing crosses it but structured-cloneable data, and the
 * only way to keep the two halves honest about that is to make them share one set of
 * types. Everything here is plain data — no functions, no class instances, no `Date`.
 *
 * ## The shape of the conversation
 *
 * ```
 *  page                                   worker
 *   |  start {code, mode, runId, ...}  ->   |   compile with new Function, call runAgent
 *   |  <- log {level, text}                 |   console.log from the learner's code
 *   |  <- model-request {id, messages}      |   only in mode:'real'
 *   |  model-response {id, ok, ...}    ->   |
 *   |  <- step {step}                       |   tool_call / tool_result / final
 *   |  <- done {finalText, messages}        |
 *   |  <- error {message, stack}            |
 *   |  cancel                          ->   |   (page also calls worker.terminate())
 * ```
 *
 * **Why the page performs the fetch rather than the worker.** A worker can call `fetch`
 * with `credentials: 'include'` perfectly well, so this is not a capability problem. It
 * is a blast-radius one: the worker is the realm that runs the learner's own code, and
 * the sandbox around that code is not a security boundary (see the worker's header
 * comment). If the worker never holds a route, a request body or the ability to make a
 * same-origin credentialled request in the first place, then the worst a runaway or a
 * copy-pasted-from-the-internet `runAgent` can do to the *server* is ask its host page
 * to make one more model call — which the page rate-limits, counts and can refuse.
 *
 * It also makes the tests possible: a stub `Worker` plus a `fetch` mock covers the whole
 * protocol without jsdom needing a real worker or a real network.
 */

/** Scripted runs never touch the network; real runs go through the page to the API. */
export type HarnessMode = 'scripted' | 'real';

// ------------------------------------------------------------- the model's view ----

/** One tool invocation the model asked for, as the learner's loop receives it. */
export interface HarnessToolCall {
  id: string;
  name: string;
  /** The parsed arguments, or `null` when the provider's arguments were not JSON. */
  args: unknown;
  /** False when the arguments did not parse. The learner's loop has to notice. */
  parseOk: boolean;
  /** The literal text the model emitted, present only when `parseOk` is false. */
  rawArgs?: string;
}

export interface HarnessAssistantReply {
  content: string;
  toolCalls: HarnessToolCall[];
}

/**
 * A message in the transcript the learner's loop maintains.
 *
 * Deliberately the same field names as `ChatMessage` in `@lab/shared`, because a real
 * run's messages are posted straight to `POST /model/chat`. It is redeclared rather than
 * imported as a value so the worker bundle stays free of Zod.
 */
export interface HarnessMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: HarnessToolCall[];
  toolName?: string;
}

/** What `runAgent` must return. Checked structurally; a learner who returns junk is told. */
export interface HarnessRunAgentResult {
  finalText: string;
  messages: HarnessMessage[];
}

// --------------------------------------------------------------- page -> worker ----

export interface StartMessage {
  type: 'start';
  /** The learner's source. Compiled with `new Function` **inside the worker**. */
  code: string;
  mode: HarnessMode;
  /** The `agent_runs` row to report steps against. Null in scripted mode. */
  runId: string | null;
  scenario: HarnessScenarioId | null;
  maxIterations: number;
  userMessage: string;
  systemPrompt: string;
  /** The tool definitions passed to `model.chat`; also the names `tools` exposes. */
  toolDefs: ToolDefinition[];
  /** Soft, in-worker deadline. The page's `terminate()` is the hard one. */
  deadlineMs: number;
}

export interface ModelResponseMessage {
  type: 'model-response';
  id: number;
  ok: boolean;
  reply?: HarnessAssistantReply;
  error?: string;
}

export interface CancelMessage {
  type: 'cancel';
}

export type PageToWorkerMessage = StartMessage | ModelResponseMessage | CancelMessage;

// --------------------------------------------------------------- worker -> page ----

export interface ModelRequestMessage {
  type: 'model-request';
  /** Correlates the response; the worker may only have one call in flight. */
  id: number;
  messages: HarnessMessage[];
  toolDefs: ToolDefinition[];
  /**
   * Which pass of the learner's loop this is. Passed straight through to
   * `POST /model/chat`, so the `model_call` row the server writes lands in the same
   * iteration group as the tool rows the worker reports for that pass.
   */
  iteration: number;
}

/**
 * A step for `POST /model/runs/:id/steps`.
 *
 * Only `tool_call`, `tool_result` and `final` are ever reported from here. `model_call`
 * steps are written by the *server* when the page posts to `/model/chat` with a `runId`,
 * and reporting them from the client as well would double every row and every token
 * count in the rollup.
 */
export interface StepMessage {
  type: 'step';
  step: ReportedStep;
}

export interface LogMessage {
  type: 'log';
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
}

export interface DoneMessage {
  type: 'done';
  finalText: string;
  messages: HarnessMessage[];
  /** How many times the learner's loop called the model. The `max-iterations` check. */
  modelCalls: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
  stack: string | null;
  /** Everything up to the failure, so a broken run still shows a trace and a count. */
  modelCalls: number;
  messages: HarnessMessage[];
}

export type WorkerToPageMessage =
  ModelRequestMessage | StepMessage | LogMessage | DoneMessage | ErrorMessage;

// ------------------------------------------------------------------- guardrails ----

/**
 * Wall clocks, page-side.
 *
 * Scripted runs do no I/O at all, so a correct one finishes in under a millisecond;
 * 60 seconds is "your loop is spinning", not "your loop is slow". Real runs are bounded
 * by the same five minutes as the server loop (`AGENT_WALL_CLOCK_MS`), because the
 * measured cost of one warm model call on the reference machine is 9-25 s and a cold
 * first call is ~70 s (docs/spike-notes.md → M10 measurements).
 */
export const SCRIPTED_TIMEOUT_MS = 60_000;
export const REAL_TIMEOUT_MS = 5 * 60 * 1000;

/** Console lines kept in the panel. A loop printing per iteration cannot flood the page. */
export const MAX_CONSOLE_LINES = 200;
/** One `console.log` argument list, truncated. 8 KB of JSON in a panel helps nobody. */
export const MAX_LOG_CHARS = 2000;
