import { SliQuerySchema, SliResponseSchema } from '@lab/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { requireFullSession } from '../auth/guards.js';
import { bearer, tokenMatches } from '../plugins/metrics.js';
import { computeSli } from './sli.js';

/**
 * `GET /api/v1/ops/sli` — the in-app SLI feed (M14).
 *
 * ## Who may read it
 *
 * **Any logged-in learner**, and a caller holding the `METRICS_TOKEN` bearer. There is no
 * admin role in this app and inventing one for a single endpoint would be ceremony rather
 * than security — Module 6 lesson 4 sends the reader to `/ops` on purpose. What the guard
 * does buy is that the error codes, prompt volumes and traffic shape are not public on the
 * deployed instance.
 *
 * ## Why the token path exists
 *
 * `.github/workflows/uptime.yml` opens a GitHub issue when the run success rate drops
 * below 80 % with at least ten runs (`docs/05-quality-and-ops.md` → Alerting). A scheduled
 * workflow has no browser and therefore no cookie, so a session-only endpoint would make
 * that half of the check unimplementable — and the honest options were "give CI an account
 * with a password and a TOTP secret", "add a second token", or "reuse the one read-only
 * token this service already has". The third is the smallest:
 *
 *  - `METRICS_TOKEN` already grants read access to exactly this class of data. `/metrics`
 *    exposes `agent_runs_total`, `model_call_duration_seconds` and
 *    `tool_call_parse_failures_total`; this endpoint exposes the same facts aggregated
 *    differently. A caller who can read one can already compute the other.
 *  - It is **read-only**. `MAINTENANCE_TOKEN` (M13) was the other candidate and was
 *    rejected for exactly that reason: it deletes rows, and a monitoring check must never
 *    hold a credential that can destroy the thing it is monitoring.
 *  - Absent `METRICS_TOKEN`, the token path simply does not exist and the endpoint is
 *    session-only. Nothing becomes more open by leaving it unset.
 *
 * `POST /ops/maintenance` lives next door in `maintenance.ts` (M13) with its own, separate
 * token, and the split is the point: different blast radius, different key.
 */

/**
 * Session **or** `METRICS_TOKEN`. The token is checked first because it is a string
 * comparison and the session guard is a database round trip.
 */
/**
 * `preHandlerHookHandler` is a union of the callback and promise shapes, so calling it
 * by hand needs the promise half named. `requireAuth` only ever returns the async one.
 */
const sessionGuard = requireFullSession as (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

async function requireSessionOrMetricsToken(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const expected = request.server.config.METRICS_TOKEN;
  const presented = bearer(request);
  if (expected && presented && tokenMatches(presented, expected)) return;
  await sessionGuard(request, reply);
}

export const opsRoutes: FastifyPluginAsync = async (app) => {
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    '/ops/sli',
    {
      preHandler: requireSessionOrMetricsToken,
      schema: {
        querystring: SliQuerySchema,
        response: { 200: SliResponseSchema },
      },
    },
    async (request) => computeSli(app.db, { hours: request.query.hours }),
  );
};
