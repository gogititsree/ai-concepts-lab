import {
  ModelChatRequestSchema,
  ModelChatResponseSchema,
  ModelHealthResponseSchema,
  RunDetailSchema,
  RunListQuerySchema,
  RunListResponseSchema,
  type ChatRequest,
  type ChatResponse,
  type StructuredOutputResult,
} from '@lab/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { authContext, requireFullSession } from '../auth/guards.js';
import { AppError, isAppError, notFound, rateLimited } from '../lib/errors.js';
import { FixedWindowLimiter } from '../plugins/rate-limit.js';
import { createProvider, modelUnavailable, type ModelProvider } from './provider.js';
import {
  findOwnedRun,
  listRuns,
  loadRun,
  RunRecorder,
  startRun,
  type StartRunInput,
} from './runs.js';
import { runStructuredChat } from './structured.js';

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

        const { exerciseId, runId, ...chatRequest } = request.body;
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
        for (const [index, attempt] of attempts.entries()) {
          await recorder.step({
            kind: 'model_call',
            iteration: index + 1,
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
            iteration: totals.iterations,
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
          await recorder.accumulate(totals);
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
  });
};
