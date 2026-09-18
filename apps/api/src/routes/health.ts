import { HealthResponseSchema } from '@lab/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

/**
 * GET /health (mounted under /api/v1).
 *
 * The response is serialised through the shared Zod schema, so the contract the web app
 * parses and the contract the API emits are literally the same object. `checks` is empty
 * in M1; M4 adds `db` and M9 adds `model` (a down model means `degraded`, not `down`, so
 * uptime monitors do not page for a missing Ollama).
 */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/health',
    {
      schema: {
        response: { 200: HealthResponseSchema },
      },
    },
    async () => ({
      status: 'ok' as const,
      version: app.config.GIT_SHA,
      checks: {},
    }),
  );
};
