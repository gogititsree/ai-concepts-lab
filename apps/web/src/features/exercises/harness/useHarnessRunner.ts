import {
  CreateRunResponseSchema,
  ModelChatResponseSchema,
  ReportStepsResponseSchema,
  RunDetailSchema,
  type ChatMessage,
  type CreateRunRequest,
  type HarnessScenarioId,
  type ReportedStep,
  type RunDetail,
  type RunStep,
  type ToolDefinition,
} from '@lab/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { apiGet, apiPost } from '../../../lib/apiClient';
import { isModelUnavailableError, useRefreshModelHealth } from '../prompt/useChatRun';
import type { ScenarioOutcome, ScenarioOutcomes } from './checks';
import {
  MAX_CONSOLE_LINES,
  REAL_TIMEOUT_MS,
  SCRIPTED_TIMEOUT_MS,
  type HarnessAssistantReply,
  type HarnessMessage,
  type PageToWorkerMessage,
  type StartMessage,
  type WorkerToPageMessage,
} from './protocol';
import { HARNESS_TOOL_DEFINITIONS } from './workerTools';

/**
 * The page's half of the worker protocol.
 *
 * Everything that needs a credential, a URL or a React state update is here; everything
 * that runs the learner's code is in the worker. The split is what lets the exercise be
 * tested at all — a stub `Worker` plus a `fetch` mock exercises this file completely,
 * and `harnessCore.ts` is exercised directly, so between the two suites there is no
 * untested seam except `postMessage` itself.
 *
 * Three things here are less obvious than they look:
 *
 * **One worker per scenario, terminated afterwards.** The three scripted checks could
 * share a worker, and sharing would be faster by about a millisecond. They do not,
 * because the `never-stops` scenario is specifically designed to be run by loops with no
 * termination condition: if a learner's `runAgent` spins without awaiting anything, the
 * runaway guard in the scripted model never gets a turn and the only way out is
 * `terminate()`. A shared worker would take the other two checks down with it.
 *
 * **The hard timeout is `terminate()`, not a flag.** Nothing inside a JavaScript realm
 * can interrupt a synchronous loop — not an `AbortSignal`, not a deadline check, not the
 * worker's own message handler, which will not run until the stack unwinds. The soft
 * deadline in `harnessCore` catches the common case (a loop that awaits); this one
 * catches the rest.
 *
 * **Steps are posted one request at a time, in order.** `POST /model/runs/:id/steps`
 * assigns step indices server-side in arrival order, so two concurrent posts would
 * interleave a `tool_result` before its `tool_call` and the trace would be a lie. The
 * chain below is three lines and removes the whole class of problem.
 */

export type WorkerFactory = () => Worker;

/**
 * The default factory, in Vite's `new Worker(new URL(...), {type:'module'})` form so the
 * bundler emits the worker as its own chunk. It is a function rather than a module-level
 * `new Worker(...)` so that importing this file in jsdom — where `Worker` does not exist
 * — costs nothing until something actually asks for a worker.
 */
const defaultWorkerFactory: WorkerFactory = () =>
  new Worker(new URL('../../../workers/harnessRunner.worker.ts', import.meta.url), {
    type: 'module',
  });

export interface ConsoleLine {
  id: number;
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
}

export type HarnessRunnerStatus = 'idle' | 'scripted' | 'real' | 'error';

export interface HarnessRunnerState {
  status: HarnessRunnerStatus;
  busy: boolean;
  elapsedMs: number;
  logs: ConsoleLine[];
  outcomes: ScenarioOutcomes;
  /** Persisted steps of the real run, as the API returned them. Feeds `AgentTrace`. */
  steps: RunStep[];
  runId: string | null;
  run: RunDetail | null;
  error: string | null;
  runScripted: (
    code: string,
    scenarios: readonly HarnessScenarioId[],
    max: number,
  ) => Promise<void>;
  runReal: (code: string, request: RealRunRequest) => Promise<void>;
  cancel: () => void;
  clearLogs: () => void;
}

export interface RealRunRequest {
  exerciseId: string;
  systemPrompt: string;
  userPrompt: string;
  maxIterations: number;
  toolNames: readonly string[];
}

// ------------------------------------------------------------- the worker driver ----

export interface WorkerOutcome {
  ok: boolean;
  finalText: string;
  messages: HarnessMessage[];
  modelCalls: number;
  error: string | null;
}

export interface DriveWorkerOptions {
  createWorker: WorkerFactory;
  start: StartMessage;
  timeoutMs: number;
  onLog: (level: ConsoleLine['level'], text: string) => void;
  onStep: (step: ReportedStep) => void;
  /** Only called in real mode; the worker never fetches. */
  onModelRequest: (
    messages: HarnessMessage[],
    toolDefs: ToolDefinition[],
    iteration: number,
  ) => Promise<HarnessAssistantReply>;
}

export interface WorkerHandle {
  outcome: Promise<WorkerOutcome>;
  cancel: () => void;
}

/**
 * Starts a worker, drives one run to completion and always tears the worker down.
 *
 * Exported so `apps/web/test/harnessWorkerProtocol.test.ts` can drive it with a stub
 * `Worker` and assert the exact message sequence, including the cancel path.
 */
export function driveWorker(options: DriveWorkerOptions): WorkerHandle {
  const worker = options.createWorker();
  let settled = false;
  // A holder rather than a bare `let`: the timer is created after `finish` closes over
  // it, and a plain variable would be either a TDZ hazard or a lint error depending on
  // which way round they are written. Same trick as `stopped` in the server's loop.
  const timers: { deadline?: ReturnType<typeof setTimeout> } = {};

  let finish!: (outcome: WorkerOutcome) => void;
  const outcome = new Promise<WorkerOutcome>((resolve) => {
    finish = (value) => {
      if (settled) return;
      settled = true;
      if (timers.deadline !== undefined) clearTimeout(timers.deadline);
      worker.terminate();
      resolve(value);
    };
  });

  const send = (message: PageToWorkerMessage): void => {
    if (!settled) worker.postMessage(message);
  };

  worker.addEventListener('message', (event: MessageEvent<WorkerToPageMessage>) => {
    const message = event.data;
    switch (message.type) {
      case 'log':
        options.onLog(message.level, message.text);
        break;
      case 'step':
        options.onStep(message.step);
        break;
      case 'model-request':
        void options
          .onModelRequest(message.messages, message.toolDefs, message.iteration)
          .then((reply) => send({ type: 'model-response', id: message.id, ok: true, reply }))
          .catch((error: unknown) =>
            send({
              type: 'model-response',
              id: message.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        break;
      case 'done':
        finish({
          ok: true,
          finalText: message.finalText,
          messages: message.messages,
          modelCalls: message.modelCalls,
          error: null,
        });
        break;
      case 'error':
        finish({
          ok: false,
          finalText: '',
          messages: message.messages,
          modelCalls: message.modelCalls,
          error: message.message,
        });
        break;
    }
  });

  // A worker that fails to load (a bundling mistake, a blocked URL) fires `error` and
  // would otherwise hang the exercise on "running…" for the whole timeout.
  worker.addEventListener('error', (event: Event) => {
    const detail = (event as ErrorEvent).message || 'the worker failed to start';
    finish({ ok: false, finalText: '', messages: [], modelCalls: 0, error: detail });
  });

  timers.deadline = setTimeout(() => {
    finish({
      ok: false,
      finalText: '',
      messages: [],
      modelCalls: 0,
      error:
        `Your loop was still running after ${Math.round(options.timeoutMs / 1000)} seconds, ` +
        'so the worker was terminated. A loop that never awaits anything cannot be ' +
        'interrupted from inside; this is the outside.',
    });
  }, options.timeoutMs);

  worker.postMessage(options.start);

  return {
    outcome,
    cancel: () => {
      // Ask politely first so a loop waiting on a model call gets a rejection it could
      // in principle handle, then take the thread away regardless.
      send({ type: 'cancel' });
      finish({
        ok: false,
        finalText: '',
        messages: [],
        modelCalls: 0,
        error: 'Cancelled.',
      });
    },
  };
}

// ------------------------------------------------------------------- the API glue ----

/** Normalises whatever the learner's loop built into something the API will accept. */
export function toChatMessages(messages: readonly HarnessMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;
    const role = message.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') continue;
    const content =
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
    out.push({
      role,
      content,
      ...(Array.isArray(message.toolCalls) && message.toolCalls.length > 0
        ? {
            toolCalls: message.toolCalls.map((call, index) => ({
              id: typeof call.id === 'string' && call.id !== '' ? call.id : `call_${index + 1}`,
              name: String(call.name ?? 'unknown'),
              args: call.args,
              parseOk: call.parseOk !== false,
              ...(call.rawArgs === undefined ? {} : { rawArgs: call.rawArgs }),
            })),
          }
        : {}),
      ...(typeof message.toolName === 'string' ? { toolName: message.toolName } : {}),
    });
  }
  return out;
}

// ------------------------------------------------------------------------- hook ----

export function useHarnessRunner(
  createWorker: WorkerFactory = defaultWorkerFactory,
): HarnessRunnerState {
  const refreshModelHealth = useRefreshModelHealth();
  const [status, setStatus] = useState<HarnessRunnerStatus>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [logs, setLogs] = useState<ConsoleLine[]>([]);
  const [outcomes, setOutcomes] = useState<ScenarioOutcomes>({});
  const [steps, setSteps] = useState<RunStep[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRef = useRef<WorkerHandle | null>(null);
  // Cancel has to stop the *sweep*, not just the scenario in flight: `runScripted` runs
  // three workers one after another, and cancelling the first only to have the second
  // start is the behaviour of a button that does not work.
  const abortRef = useRef(false);
  const logIdRef = useRef(0);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const mountedRef = useRef(true);

  // Terminating on unmount is not tidiness: without it, navigating away from a five
  // minute real run leaves a worker burning a core until the tab closes.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      handleRef.current?.cancel();
      handleRef.current = null;
    };
  }, []);

  const busy = status === 'scripted' || status === 'real';

  useEffect(() => {
    if (!busy) return;
    const startedAt = Date.now();
    setElapsedMs(0);
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 100);
    return () => clearInterval(timer);
  }, [busy]);

  const appendLog = useCallback((level: ConsoleLine['level'], text: string) => {
    logIdRef.current += 1;
    const line = { id: logIdRef.current, level, text };
    setLogs((current) => [...current, line].slice(-MAX_CONSOLE_LINES));
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  // ------------------------------------------------------------------ scripted ----

  const runScripted = useCallback(
    async (code: string, scenarios: readonly HarnessScenarioId[], max: number) => {
      setStatus('scripted');
      setError(null);
      setLogs([]);
      setOutcomes({});
      abortRef.current = false;

      const collected: ScenarioOutcomes = {};
      for (const scenario of scenarios) {
        const handle = driveWorker({
          createWorker,
          timeoutMs: SCRIPTED_TIMEOUT_MS,
          onLog: (level, text) => appendLog(level, `[${scenario}] ${text}`),
          onStep: () => {},
          onModelRequest: () =>
            Promise.reject(new Error('the scripted model runs inside the worker')),
          start: {
            type: 'start',
            code,
            mode: 'scripted',
            runId: null,
            scenario,
            maxIterations: max,
            userMessage: '',
            systemPrompt: '',
            toolDefs: Object.values(HARNESS_TOOL_DEFINITIONS),
            deadlineMs: SCRIPTED_TIMEOUT_MS,
          },
        });
        handleRef.current = handle;
        const result = await handle.outcome;
        handleRef.current = null;
        if (!mountedRef.current) return;
        if (abortRef.current) break;

        const outcome: ScenarioOutcome = {
          scenario,
          maxIterations: max,
          ok: result.ok,
          finalText: result.finalText,
          messages: result.messages,
          modelCalls: result.modelCalls,
          error: result.error,
        };
        collected[scenario] = outcome;
        // Published as each scenario lands rather than all at once: three checks going
        // green one after another is the feedback the exercise is for.
        setOutcomes({ ...collected });
      }

      setStatus('idle');
    },
    [appendLog, createWorker],
  );

  // ---------------------------------------------------------------------- real ----

  const reportSteps = useCallback(
    (id: string, batch: ReportedStep[]) => {
      queueRef.current = queueRef.current
        .then(() =>
          apiPost(`/model/runs/${id}/steps`, {
            body: { steps: batch },
            schema: ReportStepsResponseSchema,
          }),
        )
        .then((response) => {
          if (!mountedRef.current) return;
          setSteps((current) => [...current, ...response.steps]);
        })
        .catch((caught: unknown) => {
          // A failed step post must not kill the run: the learner's loop is still going,
          // and losing a trace row is much less bad than losing the answer.
          appendLog('warn', `could not record a step: ${String(caught)}`);
        });
      return queueRef.current;
    },
    [appendLog],
  );

  const runReal = useCallback(
    async (code: string, request: RealRunRequest) => {
      setStatus('real');
      setError(null);
      abortRef.current = false;
      setLogs([]);
      setSteps([]);
      setRun(null);
      setRunId(null);
      queueRef.current = Promise.resolve();

      const toolDefs = request.toolNames
        .map((name) => HARNESS_TOOL_DEFINITIONS[name])
        .filter((tool): tool is ToolDefinition => tool !== undefined);

      let created;
      try {
        const body: CreateRunRequest = {
          exerciseId: request.exerciseId,
          kind: 'harness',
          systemPrompt: request.systemPrompt,
          userPrompt: request.userPrompt,
          // The catalog names are recorded on the run row so `/runs/:id` says what the
          // model was offered. The *implementations* are the worker's, not the server's.
          tools: { catalog: [], mock: [] },
          maxIterations: request.maxIterations,
        };
        created = await apiPost('/model/runs', { body, schema: CreateRunResponseSchema });
      } catch (caught) {
        if (!mountedRef.current) return;
        if (isModelUnavailableError(caught)) refreshModelHealth();
        setError(caught instanceof Error ? caught.message : String(caught));
        setStatus('error');
        return;
      }
      if (!mountedRef.current) return;
      setRunId(created.runId);

      const handle = driveWorker({
        createWorker,
        timeoutMs: REAL_TIMEOUT_MS,
        onLog: appendLog,
        onStep: (step) => void reportSteps(created.runId, [step]),
        onModelRequest: async (messages, defs, iteration) => {
          let response;
          try {
            response = await apiPost('/model/chat', {
              body: {
                messages: toChatMessages(messages),
                ...(defs.length > 0 ? { tools: defs } : {}),
                runId: created.runId,
                // So the `model_call` row the server writes joins the tool rows this
                // pass reported, instead of every call landing in iteration 1.
                iteration,
                options: { temperature: 0 },
              },
              schema: ModelChatResponseSchema,
            });
          } catch (caught) {
            // Module 6's real run is the learner's own loop calling `/model/chat` from a
            // worker, so the failure arrives here rather than in `useChatRun` — but the
            // banner above it is the same banner and deserves the same immediate answer.
            if (isModelUnavailableError(caught)) refreshModelHealth();
            throw caught;
          }
          return {
            content: response.message.content,
            toolCalls: (response.message.toolCalls ?? []).map((call) => ({
              id: call.id,
              name: call.name,
              args: call.args,
              parseOk: call.parseOk,
              ...(call.rawArgs === undefined ? {} : { rawArgs: call.rawArgs }),
            })),
          };
        },
        start: {
          type: 'start',
          code,
          mode: 'real',
          runId: created.runId,
          scenario: null,
          maxIterations: request.maxIterations,
          userMessage: request.userPrompt,
          systemPrompt: request.systemPrompt,
          toolDefs,
          deadlineMs: REAL_TIMEOUT_MS,
        },
      });
      handleRef.current = handle;
      const result = await handle.outcome;
      handleRef.current = null;

      // Let every queued step post land before reading the run back, or the settle-time
      // GET can race the `final` step that closes the run.
      await queueRef.current.catch(() => {});
      if (!mountedRef.current) return;

      if (!result.ok) {
        setError(result.error);
        // The run row is still `running`; closing it keeps the trace honest and stops
        // its SSE stream from hanging for anyone who opens `/runs/:id`.
        try {
          await apiPost(`/model/runs/${created.runId}/cancel`);
        } catch {
          // Nothing useful to do; the error the learner needs is already on screen.
        }
      }

      try {
        const detail = await apiGet(`/model/runs/${created.runId}`, RunDetailSchema);
        if (!mountedRef.current) return;
        setRun(detail);
        setSteps(detail.steps);
      } catch (caught) {
        if (mountedRef.current) appendLog('warn', `could not read the run back: ${String(caught)}`);
      }
      if (mountedRef.current) setStatus(result.ok ? 'idle' : 'error');
    },
    [appendLog, createWorker, refreshModelHealth, reportSteps],
  );

  const cancel = useCallback(() => {
    abortRef.current = true;
    handleRef.current?.cancel();
    handleRef.current = null;
  }, []);

  return {
    status,
    busy,
    elapsedMs,
    logs,
    outcomes,
    steps,
    runId,
    run,
    error,
    runScripted,
    runReal,
    cancel,
    clearLogs,
  };
}
