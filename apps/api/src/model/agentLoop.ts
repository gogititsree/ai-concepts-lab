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
  countToolParseFailure,
  modelErrorClass,
  observeModelCall,
  observeToolExecution,
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
  logger?: { warn: (obj: unknown, msg?: string) => void };
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

  const emit = async (step: Parameters<StepWriter['step']>[0]): Promise<void> => {
    const row = await recorder.step(step);
    stepIndexUsed = row.stepIndex;
    onStep?.(toRunStep(row));
  };

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
    countRunFinished('agent', status, totals.iterationCount);
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
        // M14: the latency SLI. `response.latencyMs` is the adapter's own measurement of
        // the call, which is the number the trace already carries.
        observeModelCall({
          provider: provider.name,
          model,
          outcome: 'success',
          durationMs: response.latencyMs,
        });
      } catch (error) {
        // An abort surfaces from the provider as whatever *it* throws; the reason we
        // record comes from our own flag, not from guessing at the message.
        if (stopped.reason !== 'none' || controller.signal.aborted) {
          observeModelCall({
            provider: provider.name,
            model,
            outcome: 'aborted',
            durationMs: Date.now() - callStartedAt,
          });
          break;
        }
        const appError = isAppError(error)
          ? error
          : new AppError(500, 'INTERNAL_ERROR', 'The model call failed');
        // A failed call has no `latencyMs` of its own, so the wall clock around it is
        // the honest measurement — and for a timeout it is the interesting one.
        observeModelCall({
          provider: provider.name,
          model,
          outcome: modelErrorClass(appError.code),
          durationMs: Date.now() - callStartedAt,
        });
        await emit({
          kind: 'error',
          iteration,
          content: appError.message,
          isError: true,
          raw: { code: appError.code },
        });
        return settle('failed', lastAssistantText || null, appError.code, appError.message);
      }

      totals.iterationCount = iteration;
      totals.promptTokensTotal += response.usage.promptTokens;
      totals.completionTokensTotal += response.usage.completionTokens;
      totals.modelLatencyMsTotal += response.latencyMs;

      await emit({
        kind: 'model_call',
        iteration,
        content: response.message.content,
        latencyMs: response.latencyMs,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        raw: response.providerMeta ?? null,
      });

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
        if (!parsedByProvider) {
          totals.toolParseFailureCount += 1;
          // M14: `tool_call_parse_failures_total{tool,recovered}`. Only provider-side
          // failures reach this branch — arguments that parse but fail the tool's Zod
          // schema become a `tool_result` with `is_error` below and are deliberately not
          // counted here (docs/adr/0002 §2). `recovered` is true when the fenced-JSON
          // fallback in `ollama.ts` reconstructed a usable call out of prose.
          countToolParseFailure(call.name, call.recovered === true);
        }

        await emit({
          kind: 'tool_call',
          iteration,
          toolName: call.name,
          toolArgs: parsedByProvider ? (call.args ?? {}) : null,
          toolArgsRaw: call.rawArgs ?? null,
          parseOk: parsedByProvider,
          raw: call.recovered === true ? { recovered: true } : null,
        });

        const started = Date.now();
        let result: unknown;
        let isError = false;

        const tool = byName.get(call.name);
        if (!parsedByProvider) {
          isError = true;
          result = toolErrorResult(
            'ARGUMENTS_NOT_JSON',
            `The arguments for "${call.name}" were not valid JSON. Send the arguments as a JSON object matching the tool's schema.`,
            call.rawArgs ? [`received: ${call.rawArgs.slice(0, 200)}`] : undefined,
          );
        } else if (!tool) {
          // The hallucinated-tool case. Listing what *is* available is the difference
          // between a model that recovers on the next turn and one that repeats itself.
          isError = true;
          result = toolErrorResult('UNKNOWN_TOOL', `There is no tool named "${call.name}".`, [
            `available tools: ${[...byName.keys()].join(', ') || '(none)'}`,
          ]);
        } else {
          const parsed = tool.parse(call.args);
          if (!parsed.ok) {
            isError = true;
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
        // M14: `tool_execution_duration_seconds{tool,outcome}`. Measured 2–9 ms for every
        // catalog tool, which is the point of having it next to the model histogram.
        observeToolExecution(call.name, isError, toolDurationMs);

        await emit({
          kind: 'tool_result',
          iteration,
          toolName: call.name,
          toolResult: result ?? null,
          isError,
          latencyMs: toolDurationMs,
        });

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
