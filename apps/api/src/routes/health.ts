import { HealthResponseSchema, type HealthCheck } from '@lab/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { checkDbHealth } from '../db/health.js';
import { checkSchemaDrift } from '../db/schemaCheck.js';

export interface HealthRoutesOptions {
  /**
   * Injected so unit tests can exercise the route (and the ok/down mapping) without a
   * Postgres process. The integration suite passes nothing and hits the real database.
   */
  checkDb?: () => Promise<HealthCheck>;
  /** Same, for the schema-drift check added by M15. */
  checkSchema?: () => Promise<HealthCheck>;
}

/**
 * How long a schema-drift result is reused.
 *
 * Not cached forever, and not recomputed per request. The schema *can* change under a
 * running instance: that is precisely the expand/contract window, where a new deploy's
 * pre-deploy migration runs while the old instance is still serving traffic — which is
 * the exact state observed at 02:18:27Z in
 * `docs/postmortems/2026-09-20-rename-final-output.md`. A boot-only check would have
 * missed that half of the incident. One `information_schema` lookup a minute is free.
 */
export const SCHEMA_CHECK_TTL_MS = 60_000;

/**
 * GET /health (mounted under /api/v1).
 *
 * The response is serialised through the shared Zod schema, so the contract the web app
 * parses and the contract the API emits are literally the same object.
 *
 * Status mapping: the database is load-bearing, so a failing `checks.db` makes the whole
 * service `down`. M9 adds `checks.model`, which maps to `degraded` instead — a missing
 * Ollama must not page anyone.
 *
 * ## `checks.schema` (M15)
 *
 * The postmortem action item from the deliberate bad-migration incident. `checks.db` only
 * proves the database answers `SELECT 1`; the M15 exercise ran an instance that passed
 * that check, reported `ok`, and 500ed on every run route because a migration had renamed
 * a column out from under the code. `checks.schema` compares the columns drizzle declares
 * with the columns Postgres has, and a mismatch is **`down`** rather than `degraded`.
 *
 * `down` is the deliberate choice, because `down` is the only state anything pages on
 * (`docs/slo.md` § 1). Making schema drift `degraded` would put it in the same bucket as
 * "no model provider is attached", which is a *supported* configuration on the deployed
 * instance and must stay silent. An instance whose queries cannot run is not degraded; it
 * is unable to serve, and both `deploy.yml` (which refuses to finish a deploy unless
 * `/health` is `ok` or `degraded`) and `.github/workflows/uptime.yml` (which files an
 * incident issue on `down`) inherit the detection with no new step and no credentials.
 */
export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (app, opts) => {
  const checkDb = opts.checkDb ?? (() => checkDbHealth());
  const checkSchema =
    opts.checkSchema ??
    (async (): Promise<HealthCheck> => {
      const drift = await checkSchemaDrift(app.db);
      return drift.ok ? { ok: true } : { ok: false, detail: drift.detail ?? 'schema drift' };
    });

  let cached: { at: number; result: HealthCheck } | null = null;

  const schemaCheck = async (): Promise<HealthCheck> => {
    const now = Date.now();
    if (cached && now - cached.at < SCHEMA_CHECK_TTL_MS) return cached.result;
    try {
      const result = await checkSchema();
      cached = { at: now, result };
      return result;
    } catch (error) {
      // A check that throws must not take the endpoint with it: a health probe that
      // 500s tells a monitor nothing except "something", and the database check above
      // has already said whether Postgres is reachable at all.
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  };

  app.withTypeProvider<ZodTypeProvider>().get(
    '/health',
    {
      schema: {
        response: { 200: HealthResponseSchema },
      },
    },
    async () => {
      const db = await checkDb();
      // Skipped when the database is unreachable: the drift query would fail for the
      // same reason and would replace a precise "cannot reach the database" with a
      // confusing "cannot read information_schema".
      const schema = db.ok ? await schemaCheck() : { ok: false, detail: 'not checked' };
      return {
        status: db.ok && schema.ok ? ('ok' as const) : ('down' as const),
        version: app.config.GIT_SHA,
        checks: { db, schema },
      };
    },
  );
};
