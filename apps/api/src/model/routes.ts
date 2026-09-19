import {
  AGENT_MAX_ITERATIONS_CAP,
  AGENT_MAX_ITERATIONS_DEFAULT,
  CancelRunResponseSchema,
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  ModelChatRequestSchema,
  ModelChatResponseSchema,
  ModelHealthResponseSchema,
  ReportStepsRequestSchema,
  ReportStepsResponseSchema,
  RunDetailSchema,
  RunListQuerySchema,
  RunListResponseSchema,
  ToolCatalogResponseSchema,
  type ChatOptions,
  type ChatRequest,
  type ChatResponse,
  type RunStep,
  type RunSummary,
  type StructuredOutputResult,
} from '@lab/shared';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { authContext, requireFullSession } from '../auth/guards.js';
import { AppError, isAppError, notFound, rateLimited } from '../lib/errors.js';
import { FixedWindowLimiter } from '../plugins/rate-limit.js';
import { runAgentLoop } from './agentLoop.js';
import { createProvider, modelUnavailable, type ModelProvider } from './provider.js';
import { RunControllerRegistry, RunEventBus, RunSemaphore, type RunEvent } from './runEvents.js';
import {
  findOwnedRun,
  isTerminal,
  listRuns,
  loadRun,
  loadRunSummary,
  loadStepsAfter,
  markCancelled,
  markCompleted,
  RunRecorder,
  startRun,
  toRunStep,
  type StartRunInput,
} from './runs.js';
import { parseLastEventId, SseStream } from './sse.js';
import { runStructuredChat } from './structured.js';
import { catalogDefinitions, resolveTools, toolDefinitions, type ToolSpec } from './tools/index.js';

/**
 * `/api/v1/model/*` — the HTTP face of the `ModelProvider` seam (M9).
 *
 *   POST /model/chat        one turn, always logged as a run
 *   GET  /model/health      provider status — **public**, see below
 *   GET  /model/runs        my runs, newest first
 *   GET  /model/runs/:id    one run with its steps
 *
 * Three decisions worth stating out loud:
 *
 * **`/model/health` is the only public route here.** The dashboard banner that says "run
 * this app locally with Ollama" has to be drawable before anyone has logged in, and
 * gating it behind a session would mean the first thing a visitor sees on a
 * `MODEL_PROVIDER=none` deployment is a broken exercise rather than an explanation. The
 * response is deliberately thin — no base URL, no version, no error text from the
 * network layer (see `ModelHealthResponseSchema`).
 *
 * **`/model/chat` is rate limited per user, not per IP.** Inference is the most expensive
 * thing this process does: 6–45 seconds of CPU per call on the measured hardware. Twenty
 * calls per five minutes is roughly "as fast as a person can actually read the answers",
 * and it is per user because the threat here is an accidental loop in the learner's own
 * Module 6 harness code, not a botnet.
 *
 * **Every call writes a run, including the ones that fail.** A failed call is the more
 * interesting artefact: `agent_runs.error_code` plus the `error` step is what the SRE
 * lesson in M14/M15 reads. Writing the row only on success would make the trace table a
 * record of the times nothing went wrong.
 */

export const CHAT_RATE_LIMIT = { max: 20, windowMs: 5 * 60 * 1000 } as const;

/** A single-turn prompt run has exactly one iteration; the column is `NOT NULL`. */
const PROMPT_MAX_ITERATIONS = 1;

export interface ModelRoutesOptions {
  /** Defaults to `createProvider(app.config)`; injected by unit tests. */
  provider?: ModelProvider;
  /** Off in integration tests that are not about rate limiting. */
  rateLimits?: boolean;
}

const IdParamsSchema = z.object({ id: z.string().uuid() });

/**
 * The `Last-Event-ID` fallback as a query parameter.
 *
 * `EventSource` sets the header by itself on a reconnect, but a caller that is not an
 * `EventSource` -- curl, a test, a future worker -- cannot set headers on one, and
 * resuming a trace is exactly the thing someone debugging wants to do by hand.
 */
const EventsQuerySchema = z.object({
  lastEventId: z.coerce.number().int().min(0).optional(),
});

/** The system/user prompt columns are `NOT NULL`; a request may legitimately omit either. */
const firstSystemPrompt = (req: ChatRequest): string =>
  req.messages.find((message) => message.role === 'system')?.content ?? '';

const lastUserPrompt = (req: ChatRequest): string =>
  [...req.messages].reverse().find((message) => message.role === 'user')?.content ?? '';

interface Rollup {
  iterations: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  toolCalls: number;
  parseFailures: number;
}

function rollup(attempts: ChatResponse[]): Rollup {
  const totals: Rollup = {
    iterations: attempts.length,
    promptTokens: 0,
    completionTokens: 0,
    latencyMs: 0,
    toolCalls: 0,
    parseFailures: 0,
  };
  for (const attempt of attempts) {
    totals.promptTokens += attempt.usage.promptTokens;
    totals.completionTokens += attempt.usage.completionTokens;
    totals.latencyMs += attempt.latencyMs;
    for (const call of attempt.message.toolCalls ?? []) {
      totals.toolCalls += 1;
      if (!call.parseOk) totals.parseFailures += 1;
    }
  }
  return totals;
}

export const modelRoutes: FastifyPluginAsync<ModelRoutesOptions> = async (app, opts) => {
  const provider = opts.provider ?? createProvider(app.config);
  const routes = app.withTypeProvider<ZodTypeProvider>();
  // Per registration rather than per module, so two apps in one test process (the `fake`
  // one and the `none` one) do not share a counter.
  const chatLimiter =
    (opts.rateLimits ?? true)
      ? new FixedWindowLimiter(CHAT_RATE_LIMIT.max, CHAT_RATE_LIMIT.windowMs)
      : null;

  // ------------------------------------------------------------- M10 wiring ----
  // One bus, one controller registry and one semaphore per registration, not per module:
  // the integration suite builds a `fake` app and a `none` app in the same process and
  // they must not share a concurrency slot.
  const bus = new RunEventBus();
  const controllers = new RunControllerRegistry();
  const semaphore = new RunSemaphore();

  // A loop that is still calling Ollama when the server shuts down would write steps
  // into a closing pool. Aborting is the polite version of that race.
  app.addHook('onClose', async () => {
    controllers.abortAll();
  });

  interface BackgroundLoopInput {
    runId: string;
    userId: string;
    systemPrompt: string;
    userPrompt: string;
    tools: ToolSpec[];
    maxIterations: number;
    options: ChatOptions | undefined;
    logger: FastifyBaseLogger;
  }

  /**
   * Starts the agent loop and returns immediately.
   *
   * The `void` promise is deliberate and is the reason `POST /model/runs` can answer in
   * milliseconds while the run takes minutes. Everything that could throw is inside the
   * `try`, and the `finally` releases the semaphore and publishes the `end` event on
   * every path — including the ones where the loop itself blew up, because a run that
   * fails must still stop holding the user's one slot.
   */
  function startBackgroundLoop(input: BackgroundLoopInput): void {
    const controller = controllers.register(input.runId);
    const recorder = RunRecorder.forNewRun(app.db, input.runId);

    void (async () => {
      try {
        await runAgentLoop({
          db: app.db,
          provider,
          recorder,
          userId: input.userId,
          model: app.config.OLLAMA_CHAT_MODEL,
          systemPrompt: input.systemPrompt,
          userPrompt: input.userPrompt,
          tools: input.tools,
          maxIterations: input.maxIterations,
          options: input.options,
          signal: controller.signal,
          onStep: (step) => bus.publish(input.runId, { type: 'step', step }),
          logger: input.logger,
        });
      } catch (error) {
        // `runAgentLoop` marks the run itself on every path it knows about; this catches
        // the ones it does not (a dead pool, mostly) so the slot is still freed.
        input.logger.error({ err: error, runId: input.runId }, 'agent run crashed');
      } finally {
        controllers.release(input.runId);
        semaphore.release(input.userId, input.runId);
        try {
          const summary = await loadRunSummary(app.db, input.runId);
          if (summary) bus.publish(input.runId, { type: 'end', run: summary });
        } catch {
          // The listeners will fall back to the heartbeat timing out; nothing else to do.
        }
      }
    })();
  }

  // ------------------------------------------------------------------- health ----

  routes.get(
    '/model/health',
    { schema: { response: { 200: ModelHealthResponseSchema } } },
    async () => {
      const health = await provider.health();
      return {
        provider: provider.name,
        ok: health.ok,
        models: health.models,
        model: app.config.OLLAMA_CHAT_MODEL,
        ...(health.detail === undefined ? {} : { detail: health.detail }),
      };
    },
  );

  // ---------------------------------------------------- everything below: auth ----

  await app.register(async (secured) => {
    secured.addHook('preHandler', requireFullSession);
    const securedRoutes = secured.withTypeProvider<ZodTypeProvider>();

    // --------------------------------------------------------------- chat ----

    securedRoutes.post(
      '/model/chat',
      {
        schema: {
          body: ModelChatRequestSchema,
          response: { 200: ModelChatResponseSchema },
        },
      },
      async (request, reply) => {
        const { user } = authContext(request);

        if (chatLimiter) {
          const verdict = chatLimiter.hit(user.id);
          if (!verdict.allowed) {
            reply.header('retry-after', String(verdict.retryAfterSeconds));
            throw rateLimited(
              `Model calls are limited to ${CHAT_RATE_LIMIT.max} per five minutes. Inference is the expensive part.`,
            );
          }
        }

        // Fail before a run row exists: a deployment with no model should not accumulate
        // a trace table full of identical 503s.
        if (provider.name === 'none') {
          throw modelUnavailable(
            'No model provider is configured on this deployment. Run the app locally with Ollama to use modules 4-6.',
          );
        }

        const { exerciseId, runId, iteration, ...chatRequest } = request.body;
        if (chatRequest.format !== undefined && chatRequest.options?.think === true) {
          throw new AppError(
            400,
            'VALIDATION_FAILED',
            'think and format cannot be combined: with thinking on, this model ignores the JSON schema (docs/07-open-decisions.md, decision 16)',
          );
        }

        const model = chatRequest.model ?? app.config.OLLAMA_CHAT_MODEL;
        const structured = chatRequest.format !== undefined;

        // Either continue a run the caller opened (M11's browser-side harness) or start
        // one for this single turn. Someone else's run id is a 404, not a 403.
        let recorder: RunRecorder;
        let ownsRun: boolean;
        if (runId) {
          const existing = await findOwnedRun(app.db, user.id, runId);
          if (!existing) throw notFound(`Run ${runId} not found`);
          recorder = await RunRecorder.forExistingRun(app.db, runId);
          ownsRun = false;
        } else {
          const input: StartRunInput = {
            userId: user.id,
            exerciseId: exerciseId ?? null,
            kind: structured ? 'structured' : 'prompt',
            provider: provider.name,
            model,
            systemPrompt: firstSystemPrompt(chatRequest),
            userPrompt: lastUserPrompt(chatRequest),
            tools: chatRequest.tools ?? [],
            options: chatRequest.options ?? {},
            maxIterations: PROMPT_MAX_ITERATIONS,
            requestId: String(request.id),
          };
          const run = await startRun(app.db, input);
          recorder = RunRecorder.forNewRun(app.db, run.id);
          ownsRun = true;
        }

        // Cancelling in the browser must actually stop the inference, not just stop
        // listening to it: a 45-second call left running holds the model and the socket.
        const controller = new AbortController();
        let settled = false;
        request.raw.on('close', () => {
          if (!settled) controller.abort();
        });

        let attempts: ChatResponse[];
        let response: ChatResponse;
        let structuredResult: StructuredOutputResult | undefined;
        try {
          if (structured) {
            const outcome = await runStructuredChat(provider, chatRequest, controller.signal);
            attempts = outcome.attempts;
            response = outcome.response;
            structuredResult = outcome.result;
          } else {
            response = await provider.chat(chatRequest, controller.signal);
            attempts = [response];
          }
        } catch (error) {
          settled = true;
          const appError = isAppError(error)
            ? error
            : new AppError(500, 'INTERNAL_ERROR', 'Model call failed');
          await recorder.step({
            kind: 'error',
            iteration: 1,
            content: appError.message,
            isError: true,
          });
          if (ownsRun) {
            await recorder.finish({
              status: appError.code === 'REQUEST_ABORTED' ? 'cancelled' : 'failed',
              iterationCount: 1,
              toolCallCount: 0,
              toolParseFailureCount: 0,
              promptTokensTotal: 0,
              completionTokensTotal: 0,
              modelLatencyMsTotal: 0,
              errorCode: appError.code,
              errorMessage: appError.message,
            });
          }
          throw appError;
        }
        settled = true;

        // One `model_call` step per attempt, so a structured retry is two rows and "it
        // only worked the second time" is visible in the trace rather than inferred.
        // `iteration` is the caller's loop counter (M11's harness sends one); a
        // structured retry still advances within it, so a two-attempt call on pass 3 is
        // iterations 3 and 4. Absent, it is 1, which is what a single-turn call has
        // always recorded.
        const baseIteration = iteration ?? 1;
        for (const [index, attempt] of attempts.entries()) {
          await recorder.step({
            kind: 'model_call',
            iteration: baseIteration + index,
            content: attempt.message.content,
            latencyMs: attempt.latencyMs,
            promptTokens: attempt.usage.promptTokens,
            completionTokens: attempt.usage.completionTokens,
            raw: attempt.providerMeta ?? null,
          });
        }

        const totals = rollup(attempts);
        if (ownsRun) {
          await recorder.step({
            kind: 'final',
            iteration: baseIteration + totals.iterations - 1,
            content: response.message.content,
          });
          await recorder.finish({
            status: 'completed',
            iterationCount: totals.iterations,
            toolCallCount: totals.toolCalls,
            toolParseFailureCount: totals.parseFailures,
            promptTokensTotal: totals.promptTokens,
            completionTokensTotal: totals.completionTokens,
            modelLatencyMsTotal: totals.latencyMs,
            finalOutput: response.message.content,
          });
        } else {
          // Appending to a run somebody else is driving: M11's in-browser harness, which
          // opened a `harness` run and calls this endpoint once per iteration.
          //
          // `toolCalls: 0` rather than `totals.toolCalls`, and it is not a rounding
          // error. This handler writes **only** `model_call` rows; the `tool_call` and
          // `tool_result` rows are written by whoever actually executed the tool, through
          // `POST /model/runs/:id/steps`, and that endpoint counts them. Counting the
          // model's *request* here as well would make `tool_call_count` exactly twice the
          // number of `tool_call` rows on every harness run — a rollup that disagrees with
          // its own trace, which is the one thing a trace table must never do.
          //
          // `parseFailures` stays, because it is the opposite case: arguments that were
          // not JSON are something only this handler sees (the client is handed `args`
          // already parsed), and per docs/adr/0002 that counter is provider-side only.
          await recorder.accumulate({ ...totals, toolCalls: 0 });
        }

        return {
          ...response,
          runId: recorder.runId,
          provider: provider.name,
          model,
          ...(structuredResult ? { structuredOutput: structuredResult } : {}),
        };
      },
    );

    // --------------------------------------------------------------- runs ----

    securedRoutes.get(
      '/model/runs',
      { schema: { querystring: RunListQuerySchema, response: { 200: RunListResponseSchema } } },
      async (request) => {
        const { user } = authContext(request);
        const { limit, cursor } = request.query;
        return listRuns(app.db, user.id, { limit, ...(cursor ? { cursor } : {}) });
      },
    );

    securedRoutes.get(
      '/model/runs/:id',
      { schema: { params: IdParamsSchema, response: { 200: RunDetailSchema } } },
      async (request) => {
        const { user } = authContext(request);
        const run = await loadRun(app.db, user.id, request.params.id);
        if (!run) throw notFound(`Run ${request.params.id} not found`);
        return run;
      },
    );

    // ------------------------------------------------------ the tool catalog ----

    securedRoutes.get(
      '/model/tools',
      { schema: { response: { 200: ToolCatalogResponseSchema } } },
      async () => ({ tools: catalogDefinitions() }),
    );

    // ---------------------------------------------------------- creating a run ----

    /**
     * `POST /model/runs` → `202 {runId}`.
     *
     * 202 rather than 200 because the answer genuinely is not ready: an agent run is
     * several model calls and takes minutes on local hardware. The response is a
     * receipt, and everything after it arrives over `GET /model/runs/:id/events`.
     *
     * For `kind: 'harness'` the handler stops after creating the row. That is not a
     * missing feature — M11's loop runs in the learner's browser and reports its steps
     * back, so the server's job is to open a trace and get out of the way. Same table,
     * same viewer, different owner.
     */
    securedRoutes.post(
      '/model/runs',
      {
        schema: {
          body: CreateRunRequestSchema,
          response: { 202: CreateRunResponseSchema },
        },
      },
      async (request, reply) => {
        const { user } = authContext(request);
        const body = request.body;

        if (provider.name === 'none') {
          throw modelUnavailable(
            'No model provider is configured on this deployment. Run the app locally with Ollama to use modules 4-6.',
          );
        }

        const tools = resolveTools(body.tools);
        const maxIterations = Math.min(
          body.maxIterations ?? AGENT_MAX_ITERATIONS_DEFAULT,
          AGENT_MAX_ITERATIONS_CAP,
        );

        // Acquire *before* the insert, so a rejected second run leaves no row behind.
        if (body.kind === 'agent') {
          const slot = semaphore.tryAcquire(user.id, 'pending');
          if (!slot.ok) {
            throw new AppError(
              409,
              'RUN_IN_PROGRESS',
              'You already have an agent run in progress. Local inference is serial, so a second run would only make both slower. Wait for it or cancel it.',
              { runId: slot.runningRunId },
            );
          }
        }

        let run;
        try {
          const input: StartRunInput = {
            userId: user.id,
            exerciseId: body.exerciseId ?? null,
            kind: body.kind,
            provider: provider.name,
            model: app.config.OLLAMA_CHAT_MODEL,
            systemPrompt: body.systemPrompt,
            userPrompt: body.userPrompt,
            // The definitions **as sent to the model**, not the selection as posted:
            // docs/02-schema.md says `agent_runs.tools` is `ToolDefinition[]`, and a
            // trace that records what the model actually saw is the one worth keeping.
            tools: toolDefinitions(tools),
            options: body.options ?? {},
            maxIterations,
            requestId: String(request.id),
          };
          run = await startRun(app.db, input);
        } catch (error) {
          if (body.kind === 'agent') semaphore.release(user.id, 'pending');
          throw error;
        }

        if (body.kind === 'agent') {
          // Swap the placeholder for the real id now that there is one.
          semaphore.release(user.id, 'pending');
          semaphore.tryAcquire(user.id, run.id);
          startBackgroundLoop({
            runId: run.id,
            userId: user.id,
            systemPrompt: body.systemPrompt,
            userPrompt: body.userPrompt,
            tools,
            maxIterations,
            options: body.options,
            logger: request.log,
          });
        }

        return reply.code(202).send({ runId: run.id, kind: run.kind, status: run.status });
      },
    );

    // ----------------------------------------------------------------- events ----

    /**
     * `GET /model/runs/:id/events` — the trace, replayed then streamed.
     *
     * The ordering below is the only subtle thing in this file, and getting it wrong
     * loses steps in a way that only shows under load:
     *
     *   1. **Subscribe first.** Anything the loop publishes from here on is captured.
     *   2. Read the persisted steps after `Last-Event-ID` and write them out.
     *   3. Flush whatever arrived while (2) was running, skipping indices (2) already
     *      sent.
     *   4. Only now go live.
     *
     * Subscribing after the read would leave a window in which a step is neither in the
     * query result nor in the buffer, and it would be exactly the step that explains
     * whatever the learner is looking at.
     */
    securedRoutes.get(
      '/model/runs/:id/events',
      { schema: { params: IdParamsSchema, querystring: EventsQuerySchema } },
      async (request, reply) => {
        const { user } = authContext(request);
        const runId = request.params.id;
        const owned = await findOwnedRun(app.db, user.id, runId);
        if (!owned) throw notFound(`Run ${runId} not found`);

        const buffered: RunEvent[] = [];
        let live = false;
        let finished = false;

        reply.hijack();
        const stream = new SseStream(reply.raw);

        const sendStep = (step: RunStep): void => {
          stream.event('step', step, step.stepIndex);
        };
        const sendEnd = (run: RunSummary): void => {
          if (finished) return;
          finished = true;
          // No `id:` on purpose: a reconnect after the end must still ask for everything
          // after the last *step*, not skip one.
          stream.event('end', run);
          stream.end();
        };

        const unsubscribe = bus.subscribe(runId, (event) => {
          if (!live) {
            buffered.push(event);
            return;
          }
          if (event.type === 'step') sendStep(event.step);
          else sendEnd(event.run);
        });

        const close = (): void => {
          unsubscribe();
          stream.end();
        };
        request.raw.on('close', close);

        try {
          const after = parseLastEventId(
            request.headers['last-event-id'] ?? request.query.lastEventId,
          );
          const replayed = await loadStepsAfter(app.db, runId, after);
          for (const step of replayed) sendStep(step);
          let highest =
            replayed.length > 0 ? (replayed[replayed.length - 1] as RunStep).stepIndex : after;

          live = true;
          for (const event of buffered) {
            if (event.type === 'step') {
              if (event.step.stepIndex > highest) {
                sendStep(event.step);
                highest = event.step.stepIndex;
              }
            } else {
              sendEnd(event.run);
            }
          }
          buffered.length = 0;

          // The run may have finished before anyone subscribed, in which case there is
          // no `end` event coming and the stream would hang until the heartbeat gave up.
          if (!finished) {
            const summary = await loadRunSummary(app.db, runId);
            if (summary && isTerminal(summary.status)) sendEnd(summary);
          }
        } catch (error) {
          request.log.warn({ err: error, runId }, 'SSE replay failed');
          stream.event('error', { code: 'INTERNAL_ERROR', message: 'Could not read the trace' });
          close();
        }

        if (finished) close();
        return reply;
      },
    );

    // ----------------------------------------------------------------- cancel ----

    securedRoutes.post(
      '/model/runs/:id/cancel',
      { schema: { params: IdParamsSchema, response: { 200: CancelRunResponseSchema } } },
      async (request) => {
        const { user } = authContext(request);
        const runId = request.params.id;
        const owned = await findOwnedRun(app.db, user.id, runId);
        if (!owned) throw notFound(`Run ${runId} not found`);

        // Idempotent: cancelling a finished run is a no-op that reports the truth,
        // because the button and the run finishing are always in a race.
        if (isTerminal(owned.status)) {
          return { runId, status: owned.status };
        }

        // Two paths, both needed. If the loop is live in this process, aborting really
        // stops the inference and the loop writes its own terminal row. If it is not —
        // a harness run, or a process that restarted — the row is marked here.
        const abortedLive = controllers.abort(runId);
        await markCancelled(app.db, runId);
        if (!abortedLive) {
          const summary = await loadRunSummary(app.db, runId);
          if (summary) bus.publish(runId, { type: 'end', run: summary });
        }
        return { runId, status: 'cancelled' as const };
      },
    );

    // ------------------------------------------------- client-reported steps ----

    /**
     * `POST /model/runs/:id/steps` — the endpoint M11's in-browser harness reports to.
     *
     * This is the only place a *client* writes into the trace table, so it is the only
     * place in the model API with four separate rejections: the run must exist and be
     * yours (404, not 403 — a 403 confirms the id), it must be a `harness` run (an
     * `agent` run's trace belongs to the server loop and a client writing into it would
     * interleave step indices with the loop's own), it must still be running, and the
     * payload is capped at 20 steps of 8 KB each by the schema. A learner's loop with a
     * bug in it should cost a 400, not a table.
     */
    securedRoutes.post(
      '/model/runs/:id/steps',
      {
        schema: {
          params: IdParamsSchema,
          body: ReportStepsRequestSchema,
          response: { 201: ReportStepsResponseSchema },
        },
      },
      async (request, reply) => {
        const { user } = authContext(request);
        const runId = request.params.id;
        const owned = await findOwnedRun(app.db, user.id, runId);
        if (!owned) throw notFound(`Run ${runId} not found`);
        if (owned.kind !== 'harness') {
          throw new AppError(
            409,
            'RUN_KIND_MISMATCH',
            `Run ${runId} is a "${owned.kind}" run; only a harness run accepts client-reported steps.`,
          );
        }
        if (isTerminal(owned.status)) {
          throw new AppError(409, 'RUN_NOT_RUNNING', `Run ${runId} has already finished.`);
        }

        const recorder = await RunRecorder.forExistingRun(app.db, runId);
        const written: RunStep[] = [];
        const totals = {
          iterations: 0,
          promptTokens: 0,
          completionTokens: 0,
          latencyMs: 0,
          toolCalls: 0,
          parseFailures: 0,
        };
        let finalOutput: string | null = null;

        for (const step of request.body.steps) {
          const row = await recorder.step({
            kind: step.kind,
            iteration: step.iteration,
            content: step.content ?? null,
            toolName: step.toolName ?? null,
            toolArgs: step.toolArgs ?? null,
            toolArgsRaw: step.toolArgsRaw ?? null,
            parseOk: step.parseOk ?? null,
            toolResult: step.toolResult ?? null,
            isError: step.isError,
            latencyMs: step.latencyMs ?? null,
            promptTokens: step.promptTokens ?? null,
            completionTokens: step.completionTokens ?? null,
            raw: { reportedBy: 'client' },
          });
          const runStep = toRunStep(row);
          written.push(runStep);
          bus.publish(runId, { type: 'step', step: runStep });

          if (step.kind === 'model_call') {
            totals.iterations += 1;
            totals.promptTokens += step.promptTokens ?? 0;
            totals.completionTokens += step.completionTokens ?? 0;
            totals.latencyMs += step.latencyMs ?? 0;
          }
          if (step.kind === 'tool_call') {
            totals.toolCalls += 1;
            if (step.parseOk === false) totals.parseFailures += 1;
          }
          if (step.kind === 'final') finalOutput = step.content ?? '';
        }

        await recorder.accumulate(totals);

        // A `final` step closes the run. Without this the harness run would stay
        // `running` forever and its SSE stream would never terminate.
        if (finalOutput !== null && (await markCompleted(app.db, runId, finalOutput))) {
          const summary = await loadRunSummary(app.db, runId);
          if (summary) bus.publish(runId, { type: 'end', run: summary });
        }

        return reply.code(201).send({ steps: written });
      },
    );
  });
};
