import { createHash, timingSafeEqual } from 'node:crypto';

import { and, isNotNull, lt } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { cleanupExpiredSessions } from '../auth/housekeeping.js';
import type { Db } from '../db/client.js';
import { agentRunSteps, agentRuns } from '../db/schema.js';
import { AppError } from '../lib/errors.js';

/**
 * `POST /api/v1/ops/maintenance` — housekeeping, on a schedule that is not this process.
 *
 * **Why an endpoint at all** (decision 13 in `docs/07-open-decisions.md`). Locally,
 * `startHousekeeping` runs the same work on an hourly `setInterval`, which is the right
 * answer for a process that is always up. The deployed instance is not: a Render free
 * service sleeps after fifteen minutes of inactivity, and a sleeping process runs no
 * timers. Left as-is, the retention job would run only while somebody happened to be
 * using the app — i.e. exactly when it is least welcome, and never during the long
 * quiet periods when the rows actually pile up. So production drives it from outside,
 * with `.github/workflows/maintenance.yml`, which is free, versioned, and leaves a
 * visible run history.
 *
 * **Why a bearer token and not a session.** A scheduled workflow has no cookie, no
 * browser and no second factor. Giving it credentials for a real account would mean a
 * long-lived password and TOTP secret in CI, an account with power over data, and an
 * audit trail that says a user did this. A single-purpose token that can do exactly one
 * thing is smaller in every direction.
 *
 * **Why it is a POST that still passes the CSRF guard.** `plugins/csrf.ts` requires
 * `X-Requested-With: fetch` on every non-GET under `/api`, so the workflow sends it.
 * That is not a contradiction of what the header is for: it defends browsers against
 * cross-site form posts, and a header that script cannot set from another origin is
 * trivially set by curl — which is the point. The security here is the token.
 */

// ------------------------------------------------------------------ retention ----

/**
 * Whole runs are kept for 90 days.
 *
 * The number comes from what the rows are *for*. `agent_runs` is the durable trace store
 * that `/ops/sli` computes over, and the SLO windows in `docs/05-quality-and-ops.md` are
 * 7 and 30 days; 90 leaves room to look at a previous quarter's behaviour after a model
 * or prompt change and still be well short of "forever". They are also the most
 * sensitive rows this app holds after the auth tables — a run contains the learner's
 * prompts — and keeping those indefinitely is a liability with no matching benefit.
 */
export const RUN_RETENTION_DAYS = 90;

/**
 * `agent_run_steps.raw` is cleared after 14 days, while the step row itself stays.
 *
 * `raw` is the provider's response metadata (Ollama's timing counters) — up to 32 KB per
 * step, useful for about as long as you are debugging the call that produced it, and
 * useless afterwards. Nulling it keeps every field `/ops/sli` and the trace viewer read
 * (kind, latency, tokens, parse_ok) while dropping the bulk. This is the difference
 * between a free-tier database that lasts a year and one that fills up: it is the only
 * genuinely large column in the schema.
 *
 * Expressed as a two-stage policy on purpose — "shrink old rows, then delete older
 * rows" is the shape most retention policies have, and doing it here in miniature is
 * the lesson.
 */
export const STEP_RAW_RETENTION_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RunRetentionResult {
  agentRunsDeleted: number;
  stepRawCleared: number;
}

/**
 * Applies both retention rules. Exported and `now`-injectable so the integration test
 * can insert rows with a known age instead of waiting ninety days.
 *
 * Deleting a run cascades to its steps (`agent_run_steps.run_id … ON DELETE CASCADE`),
 * so the two statements are ordered delete-then-update: the update would otherwise
 * touch rows that the delete is about to remove.
 */
export async function applyRunRetention(
  db: Db,
  now: Date = new Date(),
): Promise<RunRetentionResult> {
  const runCutoff = new Date(now.getTime() - RUN_RETENTION_DAYS * DAY_MS);
  const rawCutoff = new Date(now.getTime() - STEP_RAW_RETENTION_DAYS * DAY_MS);

  // `.returning()` rather than the driver's row count: Drizzle's postgres-js adapter
  // does not surface `rowCount` uniformly, and the counts are the endpoint's whole
  // output. The rows are ids only, so the payload stays small even on a large sweep.
  const deletedRuns = await db
    .delete(agentRuns)
    .where(lt(agentRuns.startedAt, runCutoff))
    .returning({ id: agentRuns.id });

  const clearedSteps = await db
    .update(agentRunSteps)
    .set({ raw: null })
    // `isNotNull` keeps the count honest — without it every old step is "cleared" on
    // every run, and the number stops meaning anything.
    .where(and(lt(agentRunSteps.createdAt, rawCutoff), isNotNull(agentRunSteps.raw)))
    .returning({ id: agentRunSteps.id });

  return { agentRunsDeleted: deletedRuns.length, stepRawCleared: clearedSteps.length };
}

// ---------------------------------------------------------------------- auth ----

/**
 * Constant-time token comparison.
 *
 * `timingSafeEqual` throws on length mismatch, and taking the two lengths through
 * `a.length === b.length` first would leak the token's length through timing. Hashing
 * both sides to a fixed 32 bytes removes both problems at once.
 */
export function tokenMatches(presented: string, expected: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

/** `Authorization: Bearer <token>` → `<token>`; anything else → null. */
export function bearerToken(request: Pick<FastifyRequest, 'headers'>): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match ? (match[1] ?? null) : null;
}

// --------------------------------------------------------------------- route ----

export const MaintenanceResponseSchema = z.object({
  ranAt: z.string(),
  /** Expired session rows removed (after the one-week forensic grace period). */
  sessionsDeleted: z.number().int().nonnegative(),
  /** TOTP enrollments started and never confirmed. */
  pendingMfaDeleted: z.number().int().nonnegative(),
  /** Whole agent runs older than `RUN_RETENTION_DAYS`, with their steps. */
  agentRunsDeleted: z.number().int().nonnegative(),
  /** Steps whose `raw` payload was nulled. */
  stepRawCleared: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});

export type MaintenanceResponse = z.infer<typeof MaintenanceResponseSchema>;

export const maintenanceRoutes: FastifyPluginAsync = async (app) => {
  app
    .withTypeProvider<ZodTypeProvider>()
    .post(
      '/ops/maintenance',
      { schema: { response: { 200: MaintenanceResponseSchema } } },
      async (request) => {
        const expected = app.config.MAINTENANCE_TOKEN;
        if (!expected) {
          // 503, not 401: the endpoint is not refusing *this* caller, it is switched off.
          // A 401 here would send whoever wired up the schedule hunting for a wrong token
          // when the real answer is that the instance has none.
          throw new AppError(
            503,
            'MAINTENANCE_DISABLED',
            'MAINTENANCE_TOKEN is not configured on this instance',
          );
        }

        const presented = bearerToken(request);
        if (presented === null || !tokenMatches(presented, expected)) {
          // One code and one message for "no header" and "wrong token", for the same
          // reason `invalidCredentials()` does it: the response must not be a test oracle.
          // Logged at warn because a wrong token on this route is either a broken schedule
          // or someone probing.
          request.log.warn(
            { route: '/ops/maintenance', hasToken: presented !== null },
            'maintenance request rejected',
          );
          throw new AppError(401, 'UNAUTHENTICATED', 'A valid maintenance token is required');
        }

        const startedAt = Date.now();
        const now = new Date();
        // Sequential, not `Promise.all`: with `DB_POOL_MAX` at 3 on the deployed instance,
        // firing every statement at once would take the whole pool and stall any user
        // request unlucky enough to arrive during the sweep.
        const auth = await cleanupExpiredSessions(app.db, now);
        const runs = await applyRunRetention(app.db, now);

        const result: MaintenanceResponse = {
          ranAt: now.toISOString(),
          sessionsDeleted: auth.sessionsDeleted,
          pendingMfaDeleted: auth.pendingMfaDeleted,
          agentRunsDeleted: runs.agentRunsDeleted,
          stepRawCleared: runs.stepRawCleared,
          durationMs: Date.now() - startedAt,
        };
        // Always logged, including the all-zeroes case: "the job ran and found nothing" and
        // "the job did not run" are different facts, and only one of them is a problem.
        request.log.info(result, 'maintenance sweep complete');
        return result;
      },
    );
};
