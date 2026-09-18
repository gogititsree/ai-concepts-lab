import { HealthResponseSchema, type HealthCheck } from '@lab/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { checkDbHealth } from '../db/health.js';

export interface HealthRoutesOptions {
  /**
   * Injected so unit tests can exercise the route (and the ok/down mapping) without a
   * Postgres process. The integration suite passes nothing and hits the real database.
   */
  checkDb?: () => Promise<HealthCheck>;
}

/**
 * GET /health (mounted under /api/v1).
 *
 * The response is serialised through the shared Zod schema, so the contract the web app
 * parses and the contract the API emits are literally the same object.
 *
 * Status mapping: the database is load-bearing, so a failing `checks.db` makes the whole
 * service `down`. M9 adds `checks.model`, which maps to `degraded` instead — a missing
 * Ollama must not page anyone.
 */
export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (app, opts) => {
  const checkDb = opts.checkDb ?? (() => checkDbHealth());

  app.withTypeProvider<ZodTypeProvider>().get(
    '/health',
    {
      schema: {
        response: { 200: HealthResponseSchema },
      },
    },
    async () => {
      const db = await checkDb();
      return {
        status: db.ok ? ('ok' as const) : ('down' as const),
        version: app.config.GIT_SHA,
        checks: { db },
      };
    },
  );
};
