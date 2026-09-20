import type { RunDetail, RunStep, RunSummary } from '@lab/shared';
import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm';

import type { Db, DbLike } from '../db/client.js';
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
  /**
   * The client's idempotency key, for steps that came in over
   * `POST /model/runs/:id/steps`. Absent — and therefore NULL — for every step the
   * server writes itself. See `appendReportedStep`.
   */
  clientStepId?: string | null;
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
 * The slice of `RunRecorder` the agent loop actually needs.
 *
 * Declared so `agentLoop.ts` depends on two methods rather than on a class that owns a
 * database handle. The unit suite then drives every branch of the loop with an in-memory
 * writer that records the exact sequence of step kinds -- which is the assertion those
 * tests exist to make -- without a Postgres anywhere near them. The integration suite
 * passes the real `RunRecorder` and checks the rows.
 */
export interface StepWriter {
  readonly runId: string;
  step(input: StepInput): Promise<StepRow>;
  finish(input: FinishRunInput): Promise<void>;
}

/** The row as it goes into `agent_run_steps`, in one place so replay can re-derive it. */
function stepValues(runId: string, stepIndex: number, input: StepInput) {
  return {
    runId,
    stepIndex,
    clientStepId: input.clientStepId ?? null,
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
  };
}

/**
 * A run being written, with its own step counter.
 *
 * Constructed by `forNewRun` (the `/model/chat` case) or `forExistingRun` (a call
 * appended to a run the browser-side harness already opened in M11), and the difference
 * between the two is one `select max(step_index)`.
 *
 * Takes a `DbLike` rather than a `Db` so it can be constructed on a transaction handle:
 * `POST /model/runs/:id/steps` applies its whole batch in one transaction, and a
 * recorder holding the pool handle would write outside it.
 */
export class RunRecorder implements StepWriter {
  private stepIndex: number;

  private constructor(
    private readonly db: DbLike,
    readonly runId: string,
    startIndex: number,
  ) {
    this.stepIndex = startIndex;
  }

  static forNewRun(db: DbLike, runId: string): RunRecorder {
    return new RunRecorder(db, runId, 0);
  }

  static async forExistingRun(db: DbLike, runId: string): Promise<RunRecorder> {
    return new RunRecorder(db, runId, await nextStepIndex(db, runId));
  }

  async step(input: StepInput): Promise<StepRow> {
    const [row] = await this.db
      .insert(agentRunSteps)
      .values(stepValues(this.runId, this.stepIndex, input))
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

// ------------------------------------------- client-reported steps (M16) ----

/** The next free `step_index` for a run. One row read, not a `count(*)`. */
export async function nextStepIndex(db: DbLike, runId: string): Promise<number> {
  const [last] = await db
    .select({ stepIndex: agentRunSteps.stepIndex })
    .from(agentRunSteps)
    .where(eq(agentRunSteps.runId, runId))
    .orderBy(desc(agentRunSteps.stepIndex))
    .limit(1);
  return last ? last.stepIndex + 1 : 0;
}

/**
 * Locks a run row for the rest of the enclosing transaction.
 *
 * `POST /model/runs/:id/steps` allocates `step_index` by reading the highest one and
 * adding to it, which is a read-modify-write and therefore a race with any other writer
 * on the same run. Two concurrent posts — which is precisely what a retry that overtakes
 * its original *is* — would compute the same index and one of them would die on
 * `(run_id, step_index)` with a 500, turning a harmless duplicate into an error. The
 * lock serialises appends per run, and the run row is the natural thing to take it on
 * because every writer already has the id.
 *
 * Returns `undefined` when the run does not exist or is not this user's, so the caller
 * can 404 from inside the transaction without a second query.
 */
export async function lockRunForUpdate(
  db: DbLike,
  userId: string,
  runId: string,
): Promise<RunRow | undefined> {
  const [row] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)))
    .for('update')
    .limit(1);
  return row;
}

/**
 * What happened to one reported step.
 *
 * `conflict` is the case worth naming: the same `clientStepId` arrived carrying
 * *different* content. That is not a retry, it is two different steps claiming one
 * identity, and silently returning the first would hide a client bug behind the
 * idempotency mechanism that exists to make client bugs harmless.
 */
export type ReportedStepOutcome =
  | { status: 'created'; row: StepRow }
  | { status: 'replayed'; row: StepRow }
  | { status: 'conflict'; row: StepRow };

/**
 * JSON with its object keys sorted, recursively.
 *
 * Needed because the replay comparison puts a value that has been through `jsonb`
 * (which reorders keys by its own rules) next to one that has not. Comparing
 * `JSON.stringify` output directly would report `{"a":1,"b":2}` and `{"b":2,"a":1}` as
 * different steps and reject a perfectly good retry.
 */
export function canonicalJson(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(
        Object.keys(node as Record<string, unknown>)
          .sort()
          .map((key) => [key, walk((node as Record<string, unknown>)[key])]),
      );
    }
    return node;
  };
  return JSON.stringify(walk(value) ?? null);
}

/** The fields a replay has to match. `stepIndex`, `id` and `createdAt` are the server's. */
function stepFingerprint(row: {
  kind: string;
  iteration: number;
  content: string | null;
  toolName: string | null;
  toolArgs: unknown;
  toolArgsRaw: string | null;
  parseOk: boolean | null;
  toolResult: unknown;
  isError: boolean;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
}): string {
  return canonicalJson({
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
  });
}

async function findByClientStepId(
  db: DbLike,
  runId: string,
  clientStepId: string,
): Promise<StepRow | undefined> {
  const [row] = await db
    .select()
    .from(agentRunSteps)
    .where(and(eq(agentRunSteps.runId, runId), eq(agentRunSteps.clientStepId, clientStepId)))
    .limit(1);
  return row;
}

/**
 * Is this step one the run already has, without writing anything?
 *
 * The read-only half, for a run that has already finished. A worker whose `final` step
 * closed the run and whose response was then lost will retry it, and answering that
 * retry with "this run has finished" would report a failure at the end of a run that
 * succeeded. So a terminal run still recognises its own steps; it just cannot accept
 * new ones.
 */
export async function replayReportedStep(
  db: DbLike,
  runId: string,
  input: StepInput & { clientStepId: string },
): Promise<ReportedStepOutcome | { status: 'missing' }> {
  const existing = await findByClientStepId(db, runId, input.clientStepId);
  if (!existing) return { status: 'missing' };
  return stepFingerprint(existing) === stepFingerprint(stepValues(runId, 0, input))
    ? { status: 'replayed', row: existing }
    : { status: 'conflict', row: existing };
}

/**
 * Appends one client-reported step, or recognises it as a replay of one already stored.
 *
 * `ON CONFLICT (run_id, client_step_id) DO NOTHING` rather than a read-then-insert: the
 * check and the write are one statement, so there is no window between them, and the
 * database — not this function — is what guarantees the step appears once. The
 * `RETURNING` clause is empty exactly when the row was already there, which is how the
 * replay branch is detected without a second round trip on the common path.
 *
 * Must be called inside the transaction that holds `lockRunForUpdate`.
 */
export async function appendReportedStep(
  db: DbLike,
  runId: string,
  stepIndex: number,
  input: StepInput & { clientStepId: string },
): Promise<ReportedStepOutcome> {
  const values = stepValues(runId, stepIndex, input);
  const [inserted] = await db
    .insert(agentRunSteps)
    .values(values)
    .onConflictDoNothing({
      target: [agentRunSteps.runId, agentRunSteps.clientStepId],
    })
    .returning();
  if (inserted) return { status: 'created', row: inserted };

  const existing = await findByClientStepId(db, runId, input.clientStepId);
  // The conflict fired, so the row is there; a miss means someone deleted it between
  // the two statements, which inside one transaction cannot happen.
  if (!existing) throw new Error('reported step conflicted but could not be re-read');

  return stepFingerprint(existing) === stepFingerprint(values)
    ? { status: 'replayed', row: existing }
    : { status: 'conflict', row: existing };
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

// ------------------------------------------------------- reading, for SSE (M10) ----

/**
 * Steps after `afterIndex`, in order. The whole of `Last-Event-ID` resumption is this
 * one `>` predicate: the SSE `id:` of a step event *is* its `step_index`, so a
 * reconnecting browser tells the server exactly where it got to and gets the tail,
 * rather than a time window that can duplicate or drop rows at the boundary.
 *
 * Pass `-1` for "from the beginning", which is why the parameter is an index and not an
 * optional cursor: `0` is a real step.
 */
export async function loadStepsAfter(
  db: Db,
  runId: string,
  afterIndex: number,
  limit = 500,
): Promise<RunStep[]> {
  const rows = await db
    .select()
    .from(agentRunSteps)
    .where(and(eq(agentRunSteps.runId, runId), gt(agentRunSteps.stepIndex, afterIndex)))
    .orderBy(asc(agentRunSteps.stepIndex))
    .limit(limit);
  return rows.map(toRunStep);
}

/** The run row without its steps, for the `end` event and the cancel route. */
export async function loadRunSummary(db: DbLike, runId: string): Promise<RunSummary | null> {
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  return row ? toRunSummary(row) : null;
}

export const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'max_iterations'] as const;

export const isTerminal = (status: string): boolean =>
  (TERMINAL_STATUSES as readonly string[]).includes(status);

/**
 * Marks a run cancelled **only if it is still running**.
 *
 * The guard is the whole point. Cancel races the loop: a run that completed a
 * millisecond before the click must stay `completed`, because overwriting a real answer
 * with "cancelled" would make the trace lie about what happened. Returns whether the
 * update actually applied.
 */
export async function markCancelled(db: Db, runId: string): Promise<boolean> {
  const updated = await db
    .update(agentRuns)
    .set({
      status: 'cancelled',
      errorCode: 'RUN_CANCELLED',
      errorMessage: 'Cancelled by the user',
      finishedAt: new Date(),
    })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'running')))
    .returning({ id: agentRuns.id });
  return updated.length > 0;
}

/** Closes a run the client-side harness finished (M11's `final` step). Same race guard. */
export async function markCompleted(
  db: DbLike,
  runId: string,
  finalOutput: string | null,
): Promise<boolean> {
  const updated = await db
    .update(agentRuns)
    .set({ status: 'completed', finalOutput, finishedAt: new Date() })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'running')))
    .returning({ id: agentRuns.id });
  return updated.length > 0;
}
