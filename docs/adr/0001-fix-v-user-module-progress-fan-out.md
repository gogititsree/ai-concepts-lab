# ADR 0001 — `v_user_module_progress` counts lessons wrong; rewrite it with lateral subqueries

- **Status:** accepted
- **Date:** M7 (content, progress and quizzes from the API)
- **Deviates from:** `docs/02-schema.md` → "View: `v_user_module_progress`"

## Context

`docs/02-schema.md` defines the per-(user, module) progress rollup as one flat query:

```sql
SELECT u.id, m.id,
       count(l.id)                                                AS lessons_total,
       count(ulp.lesson_id) FILTER (WHERE ulp.status='completed') AS lessons_done,
       bool_or(uep.status='completed')                            AS exercise_done,
       bool_or(qa.passed)                                         AS quiz_passed, ...
FROM users u CROSS JOIN modules m
LEFT JOIN lessons l                  ON l.module_id = m.id
LEFT JOIN user_lesson_progress ulp   ON ulp.lesson_id = l.id AND ulp.user_id = u.id
LEFT JOIN exercises e                ON e.module_id = m.id
LEFT JOIN user_exercise_progress uep ON uep.exercise_id = e.id AND uep.user_id = u.id
LEFT JOIN quizzes q                  ON q.module_id = m.id
LEFT JOIN quiz_attempts qa           ON qa.quiz_id = q.id AND qa.user_id = u.id
GROUP BY u.id, m.id;
```

M4 transcribed it faithfully and the M4 integration tests passed, because with no
progress rows at all every LEFT JOIN contributes exactly one NULL row and the arithmetic
happens to be right.

M7 wrote the first test that submits two quiz attempts. Those three independent
one-to-many joins hang off the same FROM, so the result is their **cartesian product**:
3 lessons × 1 exercise-progress row × 2 attempts = 6 rows per (user, module). The
aggregates then count the duplicates, and a learner with three lessons and two attempts
was reported as having completed "6 of 6 lessons".

`bool_or` is idempotent, so `exercise_done` and `quiz_passed` were unaffected, and
`module_completed` compares two equally-inflated counts so it was also unaffected. Only
`lessons_total` and `lessons_done` were wrong — which are precisely the two numbers the
module cards and the dashboard rings display.

## Decision

Rewrite the view so each fact is aggregated over its own rows, with a `CROSS JOIN
LATERAL` carrying `u.id`/`m.id` into four independent scalar subqueries
(`apps/api/src/db/schema.ts`, migration `0001_fix_progress_view_fan_out.sql`).

Two things deliberately did **not** change:

- **The column list and their types.** Anything already reading the view keeps working.
- **The NULLs.** `bool_or` over zero rows is still SQL NULL, so an untouched module still
  reports `exercise_done = NULL`, `quiz_passed = NULL`, `module_completed = NULL`. The
  view stays a faithful report of what is known, and coalescing "not known" to `false`
  stays a presentation decision made in `apps/api/src/content/repository.ts` — one place,
  in SQL, so no route can forget it.

## Consequences

- One new migration; it drops and recreates a view, so it is instant and reversible.
- `docs/02-schema.md` is updated to carry the corrected SQL, with a note pointing here.
- The regression is pinned by
  `apps/api/test/integration/progress.test.ts` → "reports moduleCompleted once every
  lesson, the exercise and the quiz are done", which only passes if `lessons_total` is 3
  after two quiz attempts have been submitted.

## Alternatives considered

- **Compute the lesson counts in the API and use the view only for the booleans.** Hides
  a wrong view in the database, and the roadmap explicitly wants `GET /progress` to come
  from the view.
- **`count(DISTINCT l.id)`.** Fixes `lessons_total` and `lessons_done`, but leaves the
  query reading n×m rows to produce one, which is the actual defect. It would also have
  to be remembered by every future aggregate added to the view.
