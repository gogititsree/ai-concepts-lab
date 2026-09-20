import { getTableColumns, getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';

import type { Db } from './client.js';
import * as schema from './schema.js';

/**
 * Does the database in front of us have every column this build expects?
 *
 * ## Why this exists
 *
 * This is the prevent/detect action item from
 * `docs/postmortems/2026-09-20-rename-final-output.md`. In that incident a migration
 * renamed `agent_runs.final_output` to `output` and shipped with code that still read the
 * old name. The migration succeeded, the instance started, `GET /health` reported `ok`
 * for the whole outage — because a **connectivity** check is not a **correctness** check —
 * and every run route answered 500 with `column "final_output" does not exist`.
 *
 * Nothing in the deploy pipeline could see it. `deploy.yml`'s smoke checks are
 * unauthenticated and the run path needs a session, so the five things it asserts
 * (`/health`, a 401 from `/modules`, `/model/health`, the SPA shell, the security
 * headers) were all still true. It was verified during M15 that the smoke check passes
 * against the broken deployment.
 *
 * Drizzle knows the columns this build intends to use. Postgres knows the columns it has.
 * Comparing the two needs no credentials, no session, no model provider and no writes —
 * which is exactly why it is the check that fits this deployment, where an authenticated
 * synthetic run does not (see the comment in `.github/workflows/deploy.yml`).
 *
 * ## Missing is fatal; extra is not
 *
 * The asymmetry is the point, and getting it backwards would be worse than having no
 * check at all.
 *
 * - A column the code **declares** and the database **lacks** is the failure mode above.
 *   Every query drizzle builds enumerates its columns explicitly, so one missing column
 *   breaks every read *and* every `INSERT ... RETURNING` on that table. Fatal.
 * - A column the database **has** and the code does not declare is the *expand* phase of
 *   expand/contract — the safe, recommended pattern in
 *   `docs/runbooks/db-migration-failed.md`, where a new column is added and backfilled one
 *   deploy *before* any code reads it. Treating that as drift would make this check
 *   forbid the one migration discipline that prevents the incident it exists to catch.
 *
 * Types, nullability and defaults are deliberately not compared. They can differ for
 * legitimate reasons (a `citext` column drizzle models as `text`, a default added by a
 * migration ahead of the code), and a check that cries wolf gets disabled. Column
 * *presence* is the thing that turns into a 500.
 *
 * Views are not checked either: `v_user_module_progress` is a `pgView`, not a `PgTable`,
 * and a view whose definition has drifted fails loudly at the first query rather than
 * silently. Worth revisiting if a second view ever appears.
 */
export interface SchemaDrift {
  ok: boolean;
  /** `table.column` for every column the code declares that the database does not have. */
  missing: string[];
  /** A one-line summary, suitable for `checks.schema.detail` on `GET /health`. */
  detail?: string;
}

/** Every `pgTable` exported from `schema.ts`, discovered rather than listed by hand. */
function declaredTables(): { table: string; columns: string[] }[] {
  const out: { table: string; columns: string[] }[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    out.push({
      table: getTableName(value),
      columns: Object.values(getTableColumns(value)).map((column) => column.name),
    });
  }
  return out;
}

export async function checkSchemaDrift(db: Db): Promise<SchemaDrift> {
  // `current_schema()` rather than a literal `'public'`. Today they are the same thing
  // everywhere — production, and the throwaway-database-per-file integration harness —
  // but the one thing this check must never do is silently inspect a schema the app is
  // not using and report `ok`. Resolving it the same way the queries do costs nothing.
  const rows = (await db.execute<{ table_name: string; column_name: string }>(sql`
    select table_name, column_name
    from information_schema.columns
    where table_schema = current_schema()
  `)) as unknown as { table_name: string; column_name: string }[];

  const actual = new Map<string, Set<string>>();
  for (const row of rows) {
    let columns = actual.get(row.table_name);
    if (!columns) {
      columns = new Set<string>();
      actual.set(row.table_name, columns);
    }
    columns.add(row.column_name);
  }

  const missing: string[] = [];
  for (const { table, columns } of declaredTables()) {
    const present = actual.get(table);
    if (!present) {
      // The whole table is gone. Report it once rather than as N missing columns.
      missing.push(`${table}.*`);
      continue;
    }
    for (const column of columns) {
      if (!present.has(column)) missing.push(`${table}.${column}`);
    }
  }

  if (missing.length === 0) return { ok: true, missing: [] };
  return {
    ok: false,
    missing,
    detail:
      `the database is missing ${missing.length} column(s) this build expects: ` +
      `${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''}. ` +
      'A migration and the code that depends on it shipped together; see ' +
      'docs/runbooks/db-migration-failed.md.',
  };
}
