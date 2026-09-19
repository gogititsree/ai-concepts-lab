import type { RunDetail, RunStep, RunSummary } from '@lab/shared';
import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { agentRuns, agentRunSteps } from '../db/schema.js';

/**
 * The write and read side of `agent_runs` / `agent_run_steps`.
 *
 * Every model call this app makes leaves a durable trace here, and that is a design
 * decision rather than a logging afterthought (docs/02-schema.md, docs/05-quality-and-ops.md):
 * the trace is what the Module 4 "link to the run" points at, what the Module 5 trace
 * viewer animates in M10, what `/ops/sli` aggregates in M14, and what makes an incident
 * inspectable after the process that served it has gone.
 *
 * Two conventions the rest of the model code relies on:
 *
 *  - **`step_index` is allocated by the caller**, through `RunRecorder`, not by a
 *    `max(step_index) + 1` subquery per insert. There is a unique index on
 *    `(run_id, step_index)`, so a subquery would be a race with itself the moment M10
 *    writes steps concurrently; a counter held for the life of one request cannot be.
 *  - **Rollups are written once, at the end.** `iteration_count` and the token totals
 *    exist so `/ops/sli` never scans the step table; keeping them accurate with
 *    `UPDATE ... SET x = x + $1` per step would be three extra round trips per call for
 *    numbers nobody reads until the run is over.
 */

export type RunRow = typeof agentRuns.$inferSelect;
export type StepRow = typeof agentRunSteps.$inferSelect;

/** `agent_run_steps.raw` is capped at 32 KB (docs/02-schema.md); a long `thinking` block
 * on a 131k-context model can be much bigger than you expect. Truncated with a flag so a
 * reader knows they are looking at a fragment rather than the whole story. */
export const RAW_MAX_BYTES = 32 * 1024;

export function truncateRaw(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  const serialised = JSON.stringify(value);
  if (serialised === undefined || Buffer.byteLength(serialised, 'utf8') <= RAW_MAX_BYTES) {
    return value;
  }
  return { _truncated: true, _bytes: Buffer.byteLength(serialised, 'utf8') };
}

// --------------------------------------------------------------------- writing ----

export interface StartRunInput {
  userId: string;
  exerciseId?: string | null;
  kind: 'prompt' | 'structured' | 'agent' | 'harness';
  provider: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  tools: unknown;
  options: unknown;
  maxIterations: number;
  requestId: string;
}

export async function startRun(db: Db, input: StartRunInput): Promise<RunRow> {
  const [row] = await db
    .insert(agentRuns)
    .values({
      userId: input.userId,
      exerciseId: input.exerciseId ?? null,
      kind: input.kind,
      provider: input.provider,
      model: input.model,
      status: 'running',
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      tools: input.tools ?? [],
      options: input.options ?? {},
      maxIterations: input.maxIterations,
      requestId: input.requestId,
    })
    .returning();
  if (!row) throw new Error('failed to create agent run');
  return row;
}

export interface StepInput {
  kind: 'model_call' | 'tool_call' | 'tool_result' | 'final' | 'error';
  iteration: number;
  content?: string | null;
  toolName?: string | null;
  toolArgs?: unknown;
  toolArgsRaw?: string | null;
  parseOk?: boolean | null;
  toolResult?: unknown;
  isError?: boolean;
  latencyMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  raw?: unknown;
}

export interface FinishRunInput {
  status: 'completed' | 'failed' | 'cancelled' | 'max_iterations';
  iterationCount: number;
  toolCallCount: number;
  toolParseFailureCount: number;
  promptTokensTotal: number;
  completionTokensTotal: number;
  modelLatencyMsTotal: number;
  finalOutput?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

/**
 * A run being written, with its own step counter.
 *
 * Constructed by `forNewRun` (the `/model/chat` case) or `forExistingRun` (a call
 * appended to a run the browser-side harness already opened in M11), and the difference
 * between the two is one `select max(step_index)`.
 */
export class RunRecorder {
  private stepIndex: number;

  private constructor(
    private readonly db: Db,
    readonly runId: string,
    startIndex: number,
  ) {
    this.stepIndex = startIndex;
  }

  static forNewRun(db: Db, runId: string): RunRecorder {
    return new RunRecorder(db, runId, 0);
  }

  static async forExistingRun(db: Db, runId: string): Promise<RunRecorder> {
    const [last] = await db
      .select({ stepIndex: agentRunSteps.stepIndex })
      .from(agentRunSteps)
      .where(eq(agentRunSteps.runId, runId))
      .orderBy(desc(agentRunSteps.stepIndex))
      .limit(1);
    return new RunRecorder(db, runId, last ? last.stepIndex + 1 : 0);
  }

  async step(input: StepInput): Promise<StepRow> {
    const [row] = await this.db
      .insert(agentRunSteps)
      .values({
        runId: this.runId,
        stepIndex: this.stepIndex,
        kind: input.kind,
        iteration: input.iteration,
        content: input.content ?? null,
        toolName: input.toolName ?? null,
        toolArgs: input.toolArgs ?? null,
        toolArgsRaw: input.toolArgsRaw ?? null,
        parseOk: input.parseOk ?? null,
        toolResult: input.toolResult ?? null,
        isError: input.isError ?? false,
        latencyMs: input.latencyMs ?? null,
        promptTokens: input.promptTokens ?? null,
        completionTokens: input.completionTokens ?? null,
        raw: truncateRaw(input.raw),
      })
      .returning();
    if (!row) throw new Error('failed to append agent run step');
    this.stepIndex += 1;
    return row;
  }

  /** Writes the rollups and the terminal status in one UPDATE. */
  async finish(input: FinishRunInput): Promise<void> {
    await this.db
      .update(agentRuns)
      .set({
        status: input.status,
        iterationCount: input.iterationCount,
        toolCallCount: input.toolCallCount,
        toolParseFailureCount: input.toolParseFailureCount,
        promptTokensTotal: input.promptTokensTotal,
        completionTokensTotal: input.completionTokensTotal,
        modelLatencyMsTotal: input.modelLatencyMsTotal,
        finalOutput: input.finalOutput ?? null,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        finishedAt: new Date(),
      })
      .where(eq(agentRuns.id, this.runId));
  }

  /**
   * Adds this call's numbers to a run that stays open (the M11 harness case). Written as
   * `x = x + $1` in SQL rather than read-modify-write in JS because two worker calls can
   * land on the same run at the same time.
   */
  async accumulate(input: {
    iterations: number;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    toolCalls: number;
    parseFailures: number;
  }): Promise<void> {
    await this.db
      .update(agentRuns)
      .set({
        iterationCount: sql`${agentRuns.iterationCount} + ${input.iterations}`,
        toolCallCount: sql`${agentRuns.toolCallCount} + ${input.toolCalls}`,
        toolParseFailureCount: sql`${agentRuns.toolParseFailureCount} + ${input.parseFailures}`,
        promptTokensTotal: sql`${agentRuns.promptTokensTotal} + ${input.promptTokens}`,
        completionTokensTotal: sql`${agentRuns.completionTokensTotal} + ${input.completionTokens}`,
        modelLatencyMsTotal: sql`${agentRuns.modelLatencyMsTotal} + ${input.latencyMs}`,
      })
      .where(eq(agentRuns.id, this.runId));
  }
}

// --------------------------------------------------------------------- reading ----

export function toRunSummary(row: RunRow): RunSummary {
  return {
    id: row.id,
    exerciseId: row.exerciseId,
    kind: row.kind,
    provider: row.provider,
    model: row.model,
    status: row.status,
    iterationCount: row.iterationCount,
    toolCallCount: row.toolCallCount,
    toolParseFailureCount: row.toolParseFailureCount,
    promptTokensTotal: row.promptTokensTotal,
    completionTokensTotal: row.completionTokensTotal,
    modelLatencyMsTotal: row.modelLatencyMsTotal,
    finalOutput: row.finalOutput,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export function toRunStep(row: StepRow): RunStep {
  return {
    id: Number(row.id),
    stepIndex: row.stepIndex,
    kind: row.kind,
    iteration: row.iteration,
    content: row.content,
    toolName: row.toolName,
    toolArgs: row.toolArgs ?? null,
    toolArgsRaw: row.toolArgsRaw,
    parseOk: row.parseOk,
    toolResult: row.toolResult ?? null,
    isError: row.isError,
    latencyMs: row.latencyMs,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    raw: row.raw ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * One run with its steps, **scoped to its owner**.
 *
 * The user id is part of the WHERE clause, not an `if (run.userId !== user.id)` after the
 * fact, and someone else's run comes back as `null` → `404`, not `403`: a 403 would
 * confirm the id exists, which is a small but free information leak on a guessable
 * resource.
 */
export async function loadRun(db: Db, userId: string, runId: string): Promise<RunDetail | null> {
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)))
    .limit(1);
  if (!run) return null;

  const steps = await db
    .select()
    .from(agentRunSteps)
    .where(eq(agentRunSteps.runId, runId))
    .orderBy(asc(agentRunSteps.stepIndex));

  return {
    ...toRunSummary(run),
    systemPrompt: run.systemPrompt,
    userPrompt: run.userPrompt,
    tools: run.tools,
    options: run.options,
    maxIterations: run.maxIterations,
    requestId: run.requestId,
    steps: steps.map(toRunStep),
  };
}

/** Existence + ownership check for `POST /model/chat?runId=`, without loading the steps. */
export async function findOwnedRun(
  db: Db,
  userId: string,
  runId: string,
): Promise<RunRow | undefined> {
  const [row] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)))
    .limit(1);
  return row;
}

export interface ListRunsOptions {
  limit: number;
  /** `startedAt` of the last row of the previous page; rows come back newest first. */
  cursor?: string;
}

export async function listRuns(
  db: Db,
  userId: string,
  options: ListRunsOptions,
): Promise<{ runs: RunSummary[]; nextCursor: string | null }> {
  const where = options.cursor
    ? and(eq(agentRuns.userId, userId), lt(agentRuns.startedAt, new Date(options.cursor)))
    : eq(agentRuns.userId, userId);

  // One row more than asked for: its presence is what says "there is a next page",
  // without a second COUNT query that would be wrong by the time it returned.
  const rows = await db
    .select()
    .from(agentRuns)
    .where(where)
    .orderBy(desc(agentRuns.startedAt))
    .limit(options.limit + 1);

  const page = rows.slice(0, options.limit);
  const nextCursor =
    rows.length > options.limit && page.length > 0
      ? (page[page.length - 1]?.startedAt.toISOString() ?? null)
      : null;
  return { runs: page.map(toRunSummary), nextCursor };
}
