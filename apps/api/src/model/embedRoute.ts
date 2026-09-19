/**
 * `POST /api/v1/model/embed` — real embedding vectors for Module 3's embeddings tab.
 *
 * **M9 will very likely fold this into the `ModelProvider` seam** (`provider.embed()`
 * already exists next door, with Ollama and fake implementations). When it does, the
 * *implementation* below should be deleted and the handler should call the provider —
 * but **the route contract must not change**: same path, same request body, same
 * response shape, same `503 MODEL_UNAVAILABLE`. The web app treats `/model/embed` as a
 * source of vectors that may or may not answer, and nothing about that changes when the
 * plumbing behind it does.
 *
 * Until then this file talks to Ollama with a plain `fetch`. That is allowed because it
 * lives inside `apps/api/src/model/`, which is the only directory CLAUDE.md lets know
 * that Ollama exists. It was written this way, rather than against the provider
 * interface, because M8 and M9 were built in parallel and this route had to work before
 * the interface was finished; the duplication is deliberate, temporary and documented.
 *
 * Degradation is the feature, not the error path. The deployed instance runs
 * `MODEL_PROVIDER=none` and most learners have no Ollama, so a 503 here is the normal
 * case: the tab catches it, loads `embeddings-precomputed.json` instead, and says so on
 * screen. Which means the 503 must be *fast* and *specific* — a hung fetch would stall
 * the tab, and a 500 would look like a bug.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { requireFullSession } from '../auth/guards.js';
import { modelUnavailable } from './provider.js';

/**
 * Request and response schemas live here rather than in `packages/shared` because this
 * whole file is provisional (see above) and the web app does not import them: the
 * embeddings tab parses the response with its own narrow schema, since it also has to
 * cope with the endpoint not existing at all.
 */
const EmbedRequestSchema = z
  .object({
    /** Words or short strings. Capped so one request cannot pin the GPU for a minute. */
    texts: z.array(z.string().min(1).max(2000)).min(1).max(256),
    /** Overrides `OLLAMA_EMBED_MODEL`; the response always reports what was used. */
    model: z.string().min(1).max(128).optional(),
  })
  .strict();

const EmbedResponseSchema = z
  .object({
    embeddings: z.array(z.array(z.number())),
    model: z.string(),
    /**
     * A literal today, an enum tomorrow. The field exists so the UI can label the
     * provenance of what it is drawing without guessing from the shape of the numbers.
     */
    source: z.literal('ollama'),
  })
  .strict();

/** Long enough for a cold model load, short enough that the UI's fallback is not a hang. */
const EMBED_TIMEOUT_MS = 20_000;

export const embedRoute: FastifyPluginAsync = async (app) => {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.post(
    '/model/embed',
    {
      // Authenticated like the rest of the API. Embeddings are cheap but not free, and
      // an open endpoint that proxies arbitrary text into a local model is a gift.
      preHandler: requireFullSession,
      schema: { body: EmbedRequestSchema, response: { 200: EmbedResponseSchema } },
    },
    async (request) => {
      const cfg = app.config;
      if (cfg.MODEL_PROVIDER !== 'ollama') {
        throw modelUnavailable(
          `MODEL_PROVIDER is "${cfg.MODEL_PROVIDER}", so there is no embedding model. ` +
            'The embeddings tab falls back to the vectors shipped with the lesson.',
        );
      }

      const model = request.body.model ?? cfg.OLLAMA_EMBED_MODEL;
      const url = `${cfg.OLLAMA_BASE_URL.replace(/\/$/, '')}/api/embed`;

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: request.body.texts }),
          signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
        });
      } catch (error) {
        // Connection refused, DNS failure, timeout: all the same thing to the caller,
        // which is "there is no model here". Logged with the cause so the *operator*
        // still gets the distinction.
        request.log.warn({ err: error, url, model }, 'embed: Ollama unreachable');
        throw modelUnavailable(`Could not reach Ollama at ${cfg.OLLAMA_BASE_URL}.`);
      }

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 200);
        request.log.warn({ status: response.status, detail, model }, 'embed: Ollama error');
        // A 404 here is almost always "that model is not pulled", which is worth saying.
        throw modelUnavailable(
          response.status === 404
            ? `Ollama has no model "${model}". Try \`ollama pull ${model}\`.`
            : `Ollama returned ${response.status}.`,
        );
      }

      const body = (await response.json()) as { embeddings?: unknown };
      const embeddings = body.embeddings;
      if (!Array.isArray(embeddings) || embeddings.length !== request.body.texts.length) {
        throw modelUnavailable('Ollama returned a malformed embedding response.');
      }

      return { embeddings: embeddings as number[][], model, source: 'ollama' as const };
    },
  );
};
