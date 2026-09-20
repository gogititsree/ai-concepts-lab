import {
  AGENT_MAX_ITERATIONS_CAP,
  AGENT_WALL_CLOCK_MS,
  TOOL_TIMEOUT_MS,
  type ChatMessage,
  type ChatOptions,
  type ChatResponse,
  type RunStatus,
  type RunStep,
  type ToolCall,
} from '@lab/shared';

import type { Db } from '../db/client.js';
import { AppError, isAppError } from '../lib/errors.js';
import {
  countRunFinished,
  logModelCallContent,
  modelErrorClass,
  observeModelCall,
  observeToolCall,
  observeToolExecution,
  type TelemetryLogger,
} from '../plugins/metrics.js';
import type { ModelProvider } from './provider.js';
import { toRunStep, type StepWriter } from './runs.js';
import { toolDefinitions, toolMap, type ToolContext, type ToolSpec } from './tools/index.js';

/**
 * The server-side agent loop, transcribed from docs/01-architecture.md → "The agent loop
 * (server-side, Module 5)".
 *
 * ```
 * messages = [system, user]
 * for i in 1..maxIterations:
 *     resp = provider.chat({messages, tools})       -> step(model_call)
 *     if no tool calls: finalize(resp.content)      -> step(final); completed
 *     messages.push(assistant)
 *     for call in resp.toolCalls:
 *                                                   -> step(tool_call)
 *         result = validate-then-execute(call)      -> step(tool_result)
 *         messages.push({role:'tool', ...})
 * status = 'max_iterations'
 * ```
 *
 * Three properties are worth more than the code that implements them:
 *
 * **Every step is written as it happens.** Not buffered and flushed at the end: if this
 * process is killed in iteration four, iterations one to three are already in Postgres
 * and `/runs/:id` renders a partial trace with `status='running'` that the M15 incident
 * lesson can read. A loop that wrote its trace at the end would have nothing to show for
 * exactly the runs worth looking at.
 *
 * **A tool failure is an observation, not an exception.** An unknown tool name, arguments
 * that fail the schema, a tool that throws, a tool that times out — all four become a
 * `tool_result` step with `is_error` and a JSON error object appended to the conversation
 * as a `tool` message. The model gets a chance to recover, and the learner can see in the
 * trace whether it did. Only a *provider* failure ends the run.
 *
 * **The stopping conditions are the interesting part.** A model that never stops calling
 * tools is not a bug to be fixed in the prompt; it is a permanent property of the medium,
 * and the loop is where it is contained: `maxIterations` (default 8, hard cap 15), a
 * five-minute wall clock, ten seconds per tool, and an abort signal wired to the cancel
 * button. Module 5's fourth lesson is a tour of this paragraph.
 */

/** Distinguishes "the user pressed cancel" from "the run ran out of wall clock". */
type StopReason = 'none' | 'cancelled' | 'deadline';

export interface AgentLoopInput {
  db: Db;
  provider: ModelProvider;
  recorder: StepWriter;
  userId: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  tools: ToolSpec[];
  maxIterations: number;
  options?: ChatOptions | undefined;
  /** External cancellation (`POST /model/runs/:id/cancel`, or the process shutting down). */
  signal?: AbortSignal | undefined;
  /** Injectable so tests can pin `get_current_time` and the deadline arithmetic. */
  now?: () => Date;
  wallClockMs?: number;
  toolTimeoutMs?: number;
  /** Called after each step is persisted. This is what feeds the SSE stream. */
  onStep?: (step: RunStep) => void;
  /**
   * The **request-scoped** logger, which Fastify has already bound `reqId` onto. That
   * binding is the whole correlation story: `agent_runs.request_id` holds the same
   * value, so one Loki query by request id reaches the run and the run reaches the
   * trace. A root logger here would still work; the lines would just be orphaned.
   */
  logger?: TelemetryLogger;
}

export interface AgentLoopResult {
  status: Exclude<RunStatus, 'running'>;
  finalOutput: string | null;
  iterationCount: number;
  toolCallCount: number;
  toolParseFailureCount: number;
  promptTokensTotal: number;
  completionTokensTotal: number;
  modelLatencyMsTotal: number;
  errorCode: string | null;
  errorMessage: string | null;
}

/** The JSON a failed tool call sends back to the model. Shape is stable on purpose. */
interface ToolErrorResult {
  error: string;
  code: string;
  /** Present for a schema failure: the model's best chance of fixing its own call. */
  details?: string[];
}

const toolErrorResult = (code: string, error: string, details?: string[]): ToolErrorResult => ({
  error,
  code,
  ...(details && details.length > 0 ? { details } : {}),
});

/**
 * Races a tool against the clock.
 *
 * Honest about what it cannot do: JavaScript has no way to interrupt a function that is
 * already running, so this bounds how long the *loop* waits, not how long the tool
 * occupies the event loop. Every tool in the catalog is either pure arithmetic or one
 * indexed query, so the distinction has no teeth here — but it would the moment someone
 * adds a tool that shells out, and pretending otherwise in a comment is how that lands
 * in production.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new AppError(504, 'TOOL_TIMEOUT', `${name} took longer than ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The assistant turn as it must go back into the transcript, tool calls included. */
function assistantMessage(response: ChatResponse): ChatMessage {
  const calls = response.message.toolCalls ?? [];
  return {
    role: 'assistant',
    content: response.message.content,
    ...(calls.length > 0 ? { toolCalls: calls } : {}),
  };
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const {
    db,
    provider,
    recorder,
    userId,
    model,
    systemPrompt,
    userPrompt,
    tools,
    signal,
    onStep,
    logger,
  } = input;

  const now = input.now ?? (() => new Date());
  const wallClockMs = input.wallClockMs ?? AGENT_WALL_CLOCK_MS;
  const toolTimeoutMs = input.toolTimeoutMs ?? TOOL_TIMEOUT_MS;
  // Defence in depth: the request schema already caps this, but the loop is also called
  // directly from tests and from M11, and the hard cap belongs with the loop.
  const maxIterations = Math.min(Math.max(1, input.maxIterations), AGENT_MAX_ITERATIONS_CAP);

  const byName = toolMap(tools);
  const definitions = toolDefinitions(tools);
  const toolContext: ToolContext = { db, now, userId };

  const messages: ChatMessage[] = [
    ...(systemPrompt.trim() === '' ? [] : [{ role: 'system' as const, content: systemPrompt }]),
    { role: 'user' as const, content: userPrompt },
  ];

  // One controller for both stop conditions, so the provider sees a single signal, plus
  // a flag saying *why* it fired — a cancelled run and a timed-out run are different
  // rows in `agent_runs` and different things for an SLI to count.
  const controller = new AbortController();
  // A holder object rather than a bare `let`: the flag is written inside two callbacks
  // and TypeScript's control-flow analysis would otherwise narrow it to 'none' at every
  // later read, which is exactly the branch that must not be optimised away.
  const stopped: { reason: StopReason } = { reason: 'none' };
  const cancel = () => {
    stopped.reason = 'cancelled';
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  }
  const deadline = setTimeout(() => {
    if (stopped.reason === 'none') stopped.reason = 'deadline';
    controller.abort();
  }, wallClockMs);

  const totals = {
    iterationCount: 0,
    toolCallCount: 0,
    toolParseFailureCount: 0,
    promptTokensTotal: 0,
    completionTokensTotal: 0,
    modelLatencyMsTotal: 0,
  };
  let lastAssistantText = '';
  let stepIndexUsed = 0;

  /** Returns the index the step landed at, which is what the log lines are keyed by. */
  const emit = async (step: Parameters<StepWriter['step']>[0]): Promise<number> => {
    const row = await recorder.step(step);
    stepIndexUsed = row.stepIndex;
    onStep?.(toRunStep(row));
    return row.stepIndex;
  };

  /** The common half of every structured line this loop writes. `undefined` = no logger. */
  const logBase = logger ? { logger, runId: recorder.runId } : undefined;

  const settle = async (
    status: AgentLoopResult['status'],
    finalOutput: string | null,
    errorCode: string | null = null,
    errorMessage: string | null = null,
  ): Promise<AgentLoopResult> => {
    await recorder.finish({
      status,
      ...totals,
      finalOutput,
      errorCode,
      errorMessage,
    });
    // M14: `agent_runs_total{kind,status}` + `agent_run_iterations{kind}`. Emitted here
    // rather than at the call site so every exit path — completed, failed, cancelled and
    // the max-iterations bounded outcome — is counted exactly once. `runAgentLoop` is
    // only ever driven for an `agent` run; prompt/structured/harness runs are counted in
    // `model/routes.ts` where they finish.
    //
    // M16: and the `run_finished` line, from the same `totals` object that was just
    // written to `agent_runs` a line above.
    countRunFinished(
      'agent',
      status,
      totals.iterationCount,
      logBase && {
        ...logBase,
        provider: provider.name,
        model,
        errorCode,
        toolCalls: totals.toolCallCount,
        parseFailures: totals.toolParseFailureCount,
        promptTokens: totals.promptTokensTotal,
        completionTokens: totals.completionTokensTotal,
        latencyMs: totals.modelLatencyMsTotal,
      },
    );
    return { status, finalOutput, ...totals, errorCode, errorMessage };
  };

  try {
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      if (controller.signal.aborted) break;

      // ------------------------------------------------------------ model call ----

      let response: ChatResponse;
      const callStartedAt = Date.now();
      try {
        response = await provider.chat(
          {
            model,
            messages,
            ...(definitions.length > 0 ? { tools: definitions } : {}),
            ...(input.options ? { options: input.options } : {}),
          },
          controller.signal,
        );
        // The metric+log pair is emitted a little further down, after the `model_call`
        // row exists — the line carries its `stepIndex`, which is the field that makes
        // a log search land on a row in `agent_run_steps` rather than near one.
      } catch (error) {
        // An abort surfaces from the provider as whatever *it* throws; the reason we
        // record comes from our own flag, not from guessing at the message.
        if (stopped.reason !== 'none' || controller.signal.aborted) {
          observeModelCall({
            provider: provider.name,
            model,
            outcome: 'aborted',
            durationMs: Date.now() - callStartedAt,
            // No step was written for an aborted call, so `stepIndex` is honestly null
            // rather than pointing at the previous step's row.
            log: logBase && {
              ...logBase,
              stepIndex: null,
              iteration,
              promptTokens: 0,
              completionTokens: 0,
              errorCode: stopped.reason === 'deadline' ? 'RUN_TIMEOUT' : 'RUN_CANCELLED',
            },
          });
          break;
        }
        const appError = isAppError(error)
          ? error
          : new AppError(500, 'INTERNAL_ERROR', 'The model call failed');
        const errorStepIndex = await emit({
          kind: 'error',
          iteration,
          content: appError.message,
          isError: true,
          raw: { code: appError.code },
        });
        // A failed call has no `latencyMs` of its own, so the wall clock around it is
        // the honest measurement — and for a timeout it is the interesting one.
        //
        // This is the line whose absence the M15 postmortem is about: a handled
        // `MODEL_UNAVAILABLE` reaches no exception handler, so before M16 the whole
        // incident produced no model-path log at all.
        observeModelCall({
          provider: provider.name,
          model,
          outcome: modelErrorClass(appError.code),
          durationMs: Date.now() - callStartedAt,
          log: logBase && {
            ...logBase,
            stepIndex: errorStepIndex,
            iteration,
            promptTokens: 0,
            completionTokens: 0,
            errorCode: appError.code,
          },
        });
        return settle('failed', lastAssistantText || null, appError.code, appError.message);
      }

      totals.iterationCount = iteration;
      totals.promptTokensTotal += response.usage.promptTokens;
      totals.completionTokensTotal += response.usage.completionTokens;
      totals.modelLatencyMsTotal += response.latencyMs;

      const modelStepIndex = await emit({
        kind: 'model_call',
        iteration,
        content: response.message.content,
        latencyMs: response.latencyMs,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        raw: response.providerMeta ?? null,
      });

      // M14 latency SLI + M16 structured line, one call, one set of numbers.
      observeModelCall({
        provider: provider.name,
        model,
        outcome: 'success',
        durationMs: response.latencyMs,
        log: logBase && {
          ...logBase,
          stepIndex: modelStepIndex,
          iteration,
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
        },
      });
      if (logger) {
        // `debug` only, and the thunk is not even called at `info`. The prompts live in
        // `agent_runs`; this exists so that turning the level up is a real debugging
        // tool rather than a promise docs/05 makes and nothing keeps.
        logModelCallContent(logger, recorder.runId, modelStepIndex, () => ({
          systemPrompt,
          userPrompt,
          completion: response.message.content,
        }));
      }

      const calls: ToolCall[] = response.message.toolCalls ?? [];
      if (response.message.content.trim() !== '') lastAssistantText = response.message.content;

      // ---------------------------------------------------------------- final ----

      if (calls.length === 0) {
        await emit({ kind: 'final', iteration, content: response.message.content });
        return settle('completed', response.message.content);
      }

      messages.push(assistantMessage(response));

      // ------------------------------------------------------------ tool calls ----

      for (const call of calls) {
        if (controller.signal.aborted) break;

        totals.toolCallCount += 1;
        const parsedByProvider = call.parseOk !== false;
        if (!parsedByProvider) totals.toolParseFailureCount += 1;

        const toolCallStepIndex = await emit({
          kind: 'tool_call',
          iteration,
          toolName: call.name,
          toolArgs: parsedByProvider ? (call.args ?? {}) : null,
          toolArgsRaw: call.rawArgs ?? null,
          parseOk: parsedByProvider,
          raw: call.recovered === true ? { recovered: true } : null,
        });

        // M14: `tool_call_parse_failures_total{tool,recovered}`, incremented only for
        // provider-side failures — arguments that parse but fail the tool's Zod schema
        // become a `tool_result` with `is_error` below and are deliberately not counted
        // here (docs/adr/0002 §2). `recovered` is true when the fenced-JSON fallback in
        // `ollama.ts` reconstructed a usable call out of prose. M16: the `tool_call`
        // line is written on every call, not only the failing ones, and carries the
        // same `parseOk` the counter is defined by.
        observeToolCall({
          tool: call.name,
          parseOk: parsedByProvider,
          recovered: call.recovered === true,
          log: logBase && { ...logBase, stepIndex: toolCallStepIndex, iteration },
        });

        const started = Date.now();
        let result: unknown;
        let isError = false;
        /**
         * The `code` from the error object handed back to the model, for the
         * `tool_result` log line. Tracked separately rather than dug back out of
         * `result` so the field cannot drift from the JSON the model actually saw.
         */
        let toolErrorCode: string | null = null;

        const tool = byName.get(call.name);
        if (!parsedByProvider) {
          isError = true;
          toolErrorCode = 'ARGUMENTS_NOT_JSON';
          result = toolErrorResult(
            'ARGUMENTS_NOT_JSON',
            `The arguments for "${call.name}" were not valid JSON. Send the arguments as a JSON object matching the tool's schema.`,
            call.rawArgs ? [`received: ${call.rawArgs.slice(0, 200)}`] : undefined,
          );
        } else if (!tool) {
          // The hallucinated-tool case. Listing what *is* available is the difference
          // between a model that recovers on the next turn and one that repeats itself.
          isError = true;
          toolErrorCode = 'UNKNOWN_TOOL';
          result = toolErrorResult('UNKNOWN_TOOL', `There is no tool named "${call.name}".`, [
            `available tools: ${[...byName.keys()].join(', ') || '(none)'}`,
          ]);
        } else {
          const parsed = tool.parse(call.args);
          if (!parsed.ok) {
            isError = true;
            // Arguments that *parsed* and then failed the schema. This is a tool error
            // with its own code, and emphatically not `parseOk:false` (docs/adr/0002 §2).
            toolErrorCode = 'INVALID_ARGUMENTS';
            result = toolErrorResult(
              'INVALID_ARGUMENTS',
              `The arguments for "${call.name}" do not match its schema.`,
              parsed.errors,
            );
          } else {
            try {
              result = await withTimeout(
                Promise.resolve(tool.execute(parsed.value, toolContext)),
                toolTimeoutMs,
                call.name,
              );
            } catch (error) {
              isError = true;
              const code = isAppError(error)
                ? error.code
                : error instanceof Error && error.name === 'ToolError'
                  ? ((error as { code?: string }).code ?? 'TOOL_ERROR')
                  : 'TOOL_ERROR';
              const message = error instanceof Error ? error.message : String(error);
              toolErrorCode = code;
              // A tool crashing is a bug worth a log line even though the run survives.
              if (
                code === 'TOOL_ERROR' &&
                !(error instanceof Error && error.name === 'ToolError')
              ) {
                logger?.warn({ tool: call.name, err: message }, 'tool threw an unexpected error');
              }
              result = toolErrorResult(code, message);
            }
          }
        }

        const toolDurationMs = Date.now() - started;
        const toolResultStepIndex = await emit({
          kind: 'tool_result',
          iteration,
          toolName: call.name,
          toolResult: result ?? null,
          isError,
          latencyMs: toolDurationMs,
        });

        // M14: `tool_execution_duration_seconds{tool,outcome}`. Measured 2–9 ms for every
        // catalog tool, which is the point of having it next to the model histogram.
        // M16: and the `tool_result` line, from the same duration.
        observeToolExecution(
          call.name,
          isError,
          toolDurationMs,
          logBase && {
            ...logBase,
            stepIndex: toolResultStepIndex,
            iteration,
            errorCode: toolErrorCode,
          },
        );

        messages.push({
          role: 'tool',
          content: JSON.stringify(result ?? null),
          toolName: call.name,
        });
      }
    }

    // ------------------------------------------------------ stopped, not done ----

    if (stopped.reason === 'cancelled') {
      await emit({
        kind: 'error',
        iteration: totals.iterationCount,
        content: 'The run was cancelled.',
        isError: true,
        raw: { code: 'RUN_CANCELLED' },
      });
      return settle(
        'cancelled',
        lastAssistantText || null,
        'RUN_CANCELLED',
        'Cancelled by the user',
      );
    }
    if (stopped.reason === 'deadline') {
      await emit({
        kind: 'error',
        iteration: totals.iterationCount,
        content: `The run exceeded its ${Math.round(wallClockMs / 1000)}-second wall clock.`,
        isError: true,
        raw: { code: 'RUN_TIMEOUT' },
      });
      return settle(
        'failed',
        lastAssistantText || null,
        'RUN_TIMEOUT',
        `The run exceeded its ${Math.round(wallClockMs / 1000)}-second wall clock`,
      );
    }

    // The model never stopped asking for tools. Not an error: a bounded outcome, with
    // its own status so an SLI can count how often prompts run away.
    await emit({
      kind: 'error',
      iteration: totals.iterationCount,
      content: `Stopped after ${maxIterations} iterations without a final answer.`,
      isError: true,
      raw: { code: 'MAX_ITERATIONS' },
    });
    return settle(
      'max_iterations',
      lastAssistantText || null,
      'MAX_ITERATIONS',
      `Stopped after ${maxIterations} iterations without a final answer`,
    );
  } catch (error) {
    // Anything that gets here is a bug in this file or a database failure mid-run. The
    // run is still marked, so the partial trace has a terminal status rather than
    // sitting at `running` forever.
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn({ err: message, stepIndexUsed }, 'agent loop failed unexpectedly');
    return settle('failed', lastAssistantText || null, 'INTERNAL_ERROR', message);
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', cancel);
  }
}
