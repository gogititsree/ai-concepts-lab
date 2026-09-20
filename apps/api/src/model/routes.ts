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
import {
  countRunFinished,
  countStructuredRetries,
  logClientReportedStep,
  logModelCallContent,
  modelErrorClass,
  observeModelCall,
  setModelProviderUp,
  type RunLogContext,
} from '../plugins/metrics.js';
import { FixedWindowLimiter } from '../plugins/rate-limit.js';
import { runAgentLoop } from './agentLoop.js';
import { createProvider, modelUnavailable, type ModelProvider } from './provider.js';
import { RunControllerRegistry, RunEventBus, RunSemaphore, type RunEvent } from './runEvents.js';
import {
  appendReportedStep,
  findOwnedRun,
  isTerminal,
  listRuns,
  loadRun,
  loadRunSummary,
  loadStepsAfter,
  lockRunForUpdate,
  markCancelled,
  markCompleted,
  nextStepIndex,
  replayReportedStep,
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
      // M14: the UI polls this every 15 s while an exercise page is open, which makes it
      // the freshest evidence available about `model_provider_up`. The metrics plugin
      // probes independently for the case where nobody is looking.
      setModelProviderUp(provider.name, health.ok);
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

        // M16: what every structured line from this request carries. `request.log` is
        // the request-scoped child Fastify has already bound `reqId` onto, and
        // `agent_runs.request_id` is the same `String(request.id)` — that pairing is
        // what makes a Loki search by request id reach the trace.
        const logBase: RunLogContext = { logger: request.log, runId: recorder.runId };

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
        const callStartedAt = Date.now();
        try {
          if (structured) {
            const outcome = await runStructuredChat(provider, chatRequest, controller.signal);
            attempts = outcome.attempts;
            response = outcome.response;
            structuredResult = outcome.result;
            // M14 / decision 16: one retry per extra attempt, labelled by whether the
            // retry actually produced valid output. A rising `exhausted` share is a
            // prompt, a schema or a model version that has drifted.
            countStructuredRetries(attempts.length - 1, outcome.result.valid);
          } else {
            response = await provider.chat(chatRequest, controller.signal);
            attempts = [response];
          }
          // The success-path metric and log pair are emitted below, once each
          // `model_call` row exists and can be named by its `stepIndex`.
        } catch (error) {
          settled = true;
          const appError = isAppError(error)
            ? error
            : new AppError(500, 'INTERNAL_ERROR', 'Model call failed');
          const errorStep = await recorder.step({
            kind: 'error',
            iteration: 1,
            content: appError.message,
            isError: true,
          });
          observeModelCall({
            provider: provider.name,
            model,
            outcome: modelErrorClass(appError.code),
            durationMs: Date.now() - callStartedAt,
            log: {
              ...logBase,
              stepIndex: errorStep.stepIndex,
              iteration: 1,
              promptTokens: 0,
              completionTokens: 0,
              errorCode: appError.code,
            },
          });
          if (ownsRun) {
            const status = appError.code === 'REQUEST_ABORTED' ? 'cancelled' : 'failed';
            await recorder.finish({
              status,
              iterationCount: 1,
              toolCallCount: 0,
              toolParseFailureCount: 0,
              promptTokensTotal: 0,
              completionTokensTotal: 0,
              modelLatencyMsTotal: 0,
              errorCode: appError.code,
              errorMessage: appError.message,
            });
            countRunFinished(structured ? 'structured' : 'prompt', status, 1, {
              ...logBase,
              provider: provider.name,
              model,
              errorCode: appError.code,
              toolCalls: 0,
              parseFailures: 0,
              promptTokens: 0,
              completionTokens: 0,
              latencyMs: 0,
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
          const row = await recorder.step({
            kind: 'model_call',
            iteration: baseIteration + index,
            content: attempt.message.content,
            latencyMs: attempt.latencyMs,
            promptTokens: attempt.usage.promptTokens,
            completionTokens: attempt.usage.completionTokens,
            raw: attempt.providerMeta ?? null,
          });
          // M14: one observation per model call, so a structured retry is two points on
          // the latency histogram rather than one slow one. M16: and one log line each,
          // for the same reason — "it only worked the second time" should be as visible
          // in the log as it is in the trace.
          observeModelCall({
            provider: provider.name,
            model,
            outcome: 'success',
            durationMs: attempt.latencyMs,
            log: {
              ...logBase,
              stepIndex: row.stepIndex,
              iteration: baseIteration + index,
              promptTokens: attempt.usage.promptTokens,
              completionTokens: attempt.usage.completionTokens,
            },
          });
          logModelCallContent(request.log, recorder.runId, row.stepIndex, () => ({
            systemPrompt: firstSystemPrompt(chatRequest),
            userPrompt: lastUserPrompt(chatRequest),
            completion: attempt.message.content,
          }));
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
          // M14: prompt/structured runs finish here, not in the agent loop. M16: the
          // `run_finished` line comes off the same `totals` that were just written to
          // `agent_runs`, so the log and the row cannot disagree.
          countRunFinished(structured ? 'structured' : 'prompt', 'completed', totals.iterations, {
            ...logBase,
            provider: provider.name,
            model,
            errorCode: null,
            toolCalls: totals.toolCalls,
            parseFailures: totals.parseFailures,
            promptTokens: totals.promptTokens,
            completionTokens: totals.completionTokens,
            latencyMs: totals.latencyMs,
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

        // Highest step index actually written to this stream. Starts below zero so step 0
        // is always eligible; `Last-Event-ID` raises it before anything is sent.
        let highestSent = -1;

        /**
         * The one place a step reaches the client, and the only place that decides whether
         * it already has.
         *
         * The guard lives here rather than at the call sites because there are three of
         * them — replay, the buffer drain, and the live subscription — and it only takes
         * one to skip the check. It did: the drain compared indices but the live path did
         * not, so a step published in the window around `live = true` could be delivered
         * twice. CI caught it as `[0, 1, 1, 2, 3, 4]`; it is a duplicate card in the
         * learner's trace, and on a reconnect it would be more than one.
         *
         * Steps are strictly ordered and monotonic, so "already sent" is a comparison
         * rather than a set, and it doubles as the resume cursor.
         */
        const sendStep = (step: RunStep): void => {
          if (step.stepIndex <= highestSent) return;
          highestSent = step.stepIndex;
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
          // Resume cursor: everything up to and including `after` is already on the wire
          // from the client's previous connection, so `sendStep` must not repeat it.
          highestSent = after;

          const replayed = await loadStepsAfter(app.db, runId, after);
          for (const step of replayed) sendStep(step);

          live = true;
          for (const event of buffered) {
            if (event.type === 'step') sendStep(event.step);
            else sendEnd(event.run);
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
     *
     * ## Idempotency (M16)
     *
     * It used to have a fifth property it did not have: three identical posts made
     * three steps. `agent_run_steps` has `UNIQUE (run_id, step_index)`, which looks
     * like replay protection, but the **server** allocates `step_index`, so a replay
     * simply took the next free one and the constraint could never fire. The exposure
     * was low only because the worker does not retry — and a retry is the obvious next
     * change, at which point one network blip duplicates steps in the learner's trace.
     *
     * Each step now carries a client-chosen `clientStepId`, unique within the run and
     * enforced by an index; the reasoning for that shape is in
     * `packages/shared/src/model.ts` next to the schema. Three properties follow:
     *
     *  - **A replay is a no-op that answers like the original.** Not a 409. The whole
     *    point is that a retry is *safe*; a caller that has to distinguish "accepted"
     *    from "already had it" has not been given idempotency, it has been given a new
     *    error to handle. The response body is the same steps with the same indices.
     *  - **A reused id carrying different content is a 409.** That is not a retry, it
     *    is two different steps claiming one identity, and answering with the first
     *    would hide a client bug behind the mechanism meant to make client bugs
     *    harmless.
     *  - **The batch is one transaction**, with the run row locked for the duration, so
     *    a partially-applied batch is not a state this endpoint can be in and two
     *    concurrent posts cannot race for the same `step_index`. The rollup update and
     *    the `final` step's status change are inside it too: a batch either lands whole
     *    or not at all, rollups included.
     *
     * `step_index` remains the server's to assign, and deliberately so. The client says
     * *which step this is*, never *where it goes* — the server interleaves the client's
     * tool rows with its own `model_call` rows, and only it knows the order they
     * arrived in.
     *
     * TODO(web): `useHarnessRunner.reportSteps` must put a `clientStepId` on every step
     * it posts — a non-empty string of at most 64 characters, unique within the run and
     * **stable across retries of the same step**. `crypto.randomUUID()` minted once
     * where the step is created (not where it is posted) is the simplest correct
     * choice; a per-run counter such as `` `${runId}:${n}` `` also works. What does not
     * work is generating it inside the retry, which would make every attempt a new
     * step. `harnessCore`'s four `onStep({...})` literals are where the id has to be
     * born, because that is the moment a step exists; the posting queue only forwards
     * it. See `docs/adr/0007` §5. Until then `apps/web` will not typecheck, which is
     * the intended signal rather than a runtime 400 nobody sees.
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
        const logBase: RunLogContext = { logger: request.log, runId };

        // Everything the client's batch touches happens in here. `app.db.transaction`
        // rolls back on any throw, including the `AppError`s below, so a rejected batch
        // cannot leave a step behind.
        const applied = await app.db.transaction(async (tx) => {
          const owned = await lockRunForUpdate(tx, user.id, runId);
          if (!owned) throw notFound(`Run ${runId} not found`);
          if (owned.kind !== 'harness') {
            throw new AppError(
              409,
              'RUN_KIND_MISMATCH',
              `Run ${runId} is a "${owned.kind}" run; only a harness run accepts client-reported steps.`,
            );
          }
          // Mapping the wire shape onto a step row, in one place: the replay-only path
          // below has to build the identical object or the fingerprints will not match.
          const toStepInput = (step: (typeof request.body.steps)[number]) => ({
            clientStepId: step.clientStepId,
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

          const reuseConflict = (clientStepId: string, stepIndex: number): AppError =>
            new AppError(
              409,
              'IDEMPOTENCY_KEY_REUSED',
              `clientStepId "${clientStepId}" was already used in run ${runId} for a different step. An id names one step for the life of the run; send a new one.`,
              { clientStepId, stepIndex },
            );

          if (isTerminal(owned.status)) {
            // A finished run cannot take new steps — but it can still recognise its
            // own. The worker's very last post is the `final` that closed the run, so
            // the retry most likely to happen is the one that arrives here, and
            // answering it with a failure would make a successful run look broken.
            const replays: { step: RunStep; created: boolean }[] = [];
            for (const step of request.body.steps) {
              const outcome = await replayReportedStep(tx, runId, toStepInput(step));
              if (outcome.status === 'conflict') {
                throw reuseConflict(step.clientStepId, outcome.row.stepIndex);
              }
              if (outcome.status === 'missing') {
                throw new AppError(409, 'RUN_NOT_RUNNING', `Run ${runId} has already finished.`);
              }
              replays.push({ step: toRunStep(outcome.row), created: false });
            }
            return { written: replays, owned, completed: false, summary: null };
          }

          const written: { step: RunStep; created: boolean }[] = [];
          const totals = {
            iterations: 0,
            promptTokens: 0,
            completionTokens: 0,
            latencyMs: 0,
            toolCalls: 0,
            parseFailures: 0,
          };
          let finalOutput: string | null = null;
          // Read once and advanced in memory: the run row is locked, so nobody else is
          // allocating indices for this run while this transaction runs.
          let stepIndex = await nextStepIndex(tx, runId);

          for (const step of request.body.steps) {
            const outcome = await appendReportedStep(tx, runId, stepIndex, toStepInput(step));

            if (outcome.status === 'conflict') {
              throw reuseConflict(step.clientStepId, outcome.row.stepIndex);
            }

            const created = outcome.status === 'created';
            written.push({ step: toRunStep(outcome.row), created });
            if (!created) continue;

            // Only a step that was actually inserted moves anything. A replay that
            // added to the rollups would make `agent_runs` disagree with its own trace
            // — exactly the failure the idempotency key exists to prevent, so
            // reintroducing it one layer up would be a poor joke.
            stepIndex += 1;
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

          await RunRecorder.forNewRun(tx, runId).accumulate(totals);

          // A `final` step closes the run. Without this the harness run would stay
          // `running` forever and its SSE stream would never terminate. `markCompleted`
          // only applies to a `running` run, so a replayed `final` is a no-op here too.
          const completed = finalOutput !== null && (await markCompleted(tx, runId, finalOutput));
          const summary = completed ? await loadRunSummary(tx, runId) : null;
          return { written, owned, completed, summary };
        });

        // Side effects that must wait for the commit: an SSE subscriber told about a
        // step that then rolled back would be looking at a row nobody else can see.
        for (const { step, created } of applied.written) {
          if (!created) continue;
          bus.publish(runId, { type: 'step', step });
          logClientReportedStep(logBase, step, applied.owned);
        }
        if (applied.completed) {
          if (applied.summary) bus.publish(runId, { type: 'end', run: applied.summary });
          // M14: a harness run's terminal status is decided here, by the browser's own
          // loop reporting its `final` step. `iterationCount` comes from the row because
          // this request only saw the last batch of steps.
          countRunFinished('harness', 'completed', applied.summary?.iterationCount ?? 0, {
            ...logBase,
            provider: applied.owned.provider,
            model: applied.owned.model,
            errorCode: null,
            toolCalls: applied.summary?.toolCallCount ?? 0,
            parseFailures: applied.summary?.toolParseFailureCount ?? 0,
            promptTokens: applied.summary?.promptTokensTotal ?? 0,
            completionTokens: applied.summary?.completionTokensTotal ?? 0,
            latencyMs: applied.summary?.modelLatencyMsTotal ?? 0,
          });
        }

        return reply.code(201).send({ steps: applied.written.map((entry) => entry.step) });
      },
    );
  });
};
