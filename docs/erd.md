# Entity-relationship diagram

Hand-written from `apps/api/src/db/schema.ts` (M4). The authority for column semantics is
[`02-schema.md`](./02-schema.md); this page is the shape at a glance.

Three clusters, joined only through `users` and `exercises`:

- **Identity & auth** — `users`, `mfa_totp`, `mfa_backup_codes`, `sessions`, `auth_events`
- **Curriculum content** — `modules`, `lessons`, `exercises`, `quizzes`, `quiz_questions`
  (all seeded from `content/`, all with uuid-v5 primary keys)
- **Learner state & observability** — progress tables, quiz attempts, agent runs and steps

```mermaid
erDiagram
    users ||--o| mfa_totp : "1:1, cascade"
    users ||--o{ mfa_backup_codes : "cascade"
    users ||--o{ sessions : "cascade"
    users ||--o{ auth_events : "set null"
    users ||--o{ user_lesson_progress : "cascade"
    users ||--o{ user_exercise_progress : "cascade"
    users ||--o{ quiz_attempts : "cascade"
    users ||--o{ agent_runs : "cascade"

    modules ||--o{ lessons : "cascade"
    modules ||--o{ exercises : "cascade"
    modules ||--|| quizzes : "cascade, unique"
    quizzes ||--o{ quiz_questions : "cascade"
    lessons |o--o{ exercises : "optional anchor, set null"

    lessons ||--o{ user_lesson_progress : "cascade"
    exercises ||--o{ user_exercise_progress : "cascade"
    quizzes ||--o{ quiz_attempts : "cascade"
    quiz_attempts ||--o{ quiz_attempt_answers : "cascade"
    quiz_questions ||--o{ quiz_attempt_answers : "cascade"
    exercises |o--o{ agent_runs : "set null"
    agent_runs ||--o{ agent_run_steps : "cascade"

    users {
        uuid id PK
        citext email UK "case-insensitive"
        text password_hash "argon2id"
        text display_name
        boolean mfa_enabled "denormalized from mfa_totp"
        int failed_login_count
        timestamptz locked_until "nullable"
        timestamptz created_at
        timestamptz updated_at
    }

    mfa_totp {
        uuid user_id PK_FK
        bytea secret_ciphertext "AES-256-GCM"
        bytea secret_iv
        bytea secret_tag
        smallint key_version
        timestamptz confirmed_at "null = pending"
        bigint last_used_step "replay guard"
        timestamptz created_at
    }

    mfa_backup_codes {
        uuid id PK
        uuid user_id FK
        text code_hash "argon2id"
        timestamptz used_at "single use"
        timestamptz created_at
    }

    sessions {
        bytea id PK "sha256(token)"
        uuid user_id FK
        timestamptz mfa_verified_at "null = pending session"
        timestamptz created_at
        timestamptz last_seen_at
        timestamptz expires_at
        inet ip
        text user_agent
        timestamptz revoked_at
    }

    auth_events {
        bigserial id PK
        uuid user_id FK "null for unknown email"
        auth_event_type event_type
        inet ip
        text user_agent
        jsonb metadata
        timestamptz created_at
    }

    modules {
        uuid id PK "uuid v5 of slug"
        text slug UK
        text title
        text summary
        int order_index UK
        boolean requires_model
        boolean is_published
        int content_version
    }

    lessons {
        uuid id PK "uuid v5"
        uuid module_id FK
        text slug "unique per module"
        text title
        int order_index "unique per module"
        text body_md
        int estimated_minutes
    }

    exercises {
        uuid id PK "uuid v5"
        uuid module_id FK
        uuid lesson_id FK "nullable anchor"
        text slug "unique per module"
        text title
        exercise_kind kind
        jsonb config
        int order_index
        jsonb completion_rule
    }

    quizzes {
        uuid id PK "uuid v5"
        uuid module_id FK_UK "one quiz per module"
        text title
        numeric pass_threshold "default 0.70"
    }

    quiz_questions {
        uuid id PK "uuid v5"
        uuid quiz_id FK
        int order_index "unique per quiz"
        question_kind kind
        text prompt_md
        jsonb options "choice kinds only"
        jsonb correct "never serialised by GET /quizzes/:id"
        text explanation_md
        int points
    }

    user_lesson_progress {
        uuid user_id PK_FK
        uuid lesson_id PK_FK
        progress_status status
        timestamptz completed_at
        timestamptz updated_at
    }

    user_exercise_progress {
        uuid user_id PK_FK
        uuid exercise_id PK_FK
        progress_status status
        jsonb state "learner's saved work"
        text_array tasks_completed
        timestamptz completed_at
        timestamptz updated_at
    }

    quiz_attempts {
        uuid id PK
        uuid user_id FK
        uuid quiz_id FK
        timestamptz started_at
        timestamptz submitted_at
        int score_points
        int max_points
        boolean passed "historical truth"
    }

    quiz_attempt_answers {
        uuid attempt_id PK_FK
        uuid question_id PK_FK
        jsonb answer
        boolean is_correct
        int points_awarded
    }

    agent_runs {
        uuid id PK
        uuid user_id FK
        uuid exercise_id FK "null = playground"
        run_kind kind
        text provider
        text model
        run_status status
        text system_prompt
        text user_prompt
        jsonb tools
        jsonb options
        int max_iterations
        int iteration_count
        int tool_call_count
        int tool_parse_failure_count
        int prompt_tokens_total
        int completion_tokens_total
        int model_latency_ms_total
        text final_output
        text error_code
        text error_message
        timestamptz started_at
        timestamptz finished_at
        text request_id
    }

    agent_run_steps {
        bigserial id PK
        uuid run_id FK
        int step_index "unique per run"
        step_kind kind
        int iteration
        text content
        text tool_name
        jsonb tool_args
        text tool_args_raw
        boolean parse_ok
        jsonb tool_result
        boolean is_error
        int latency_ms
        int prompt_tokens
        int completion_tokens
        jsonb raw
        timestamptz created_at
    }
```

## View `v_user_module_progress`

Not in the diagram above because Mermaid's `erDiagram` has no notion of a view. It is a
`users CROSS JOIN modules` with six LEFT JOINs and one `GROUP BY (user, module)`, so every
user gets one row per module whether or not they have touched it:

| column           | type    | note                                              |
| ---------------- | ------- | ------------------------------------------------- |
| user_id          | uuid    |                                                   |
| module_id        | uuid    |                                                   |
| lessons_total    | bigint  | `count(l.id)`                                     |
| lessons_done     | bigint  | `count(...) FILTER (WHERE status='completed')`    |
| exercise_done    | boolean | `bool_or(...)` — **NULL** when no progress row     |
| quiz_passed      | boolean | `bool_or(...)` — **NULL** when no attempt          |
| module_completed | boolean | all three conditions; three-valued logic applies   |

## Enums

`progress_status`, `exercise_kind`, `question_kind`, `run_kind`, `run_status`, `step_kind`,
`auth_event_type` — values in `02-schema.md`, defined once in `schema.ts` via `pgEnum`.

## Notes on the Drizzle mapping

- `citext` and `bytea` have no Drizzle built-in and are declared with `customType`;
  `inet` is built in and used directly.
- The `citext` and `pgcrypto` extensions are created by hand at the top of
  `0000_initial_schema.sql`: drizzle-kit has no concept of extensions, and everything after
  them depends on them (`users.email` and every `gen_random_uuid()` default).
- The view **is** emitted by drizzle-kit from `pgView(...).as(sql\`...\`)`, so no
  hand-editing was needed for it.

---

## `EXPLAIN ANALYZE` of the view (M4 acceptance item)

<!--
Recorded 2026-09-17 against the seeded local database (docker compose postgres:16-alpine)
with six modules, six lessons, six exercises, six quizzes, fifteen quiz questions and
exactly one user with no progress rows — the state the roadmap asks about.

  $ pnpm db:up && pnpm db:migrate && pnpm db:seed
  $ psql -U lab -d lab
  lab=# INSERT INTO users (email, password_hash, display_name)
        VALUES ('explain@example.com', '$argon2id$placeholder', 'Explain User');
  lab=# ANALYZE;
  lab=# EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM v_user_module_progress;

                                     QUERY PLAN
  ------------------------------------------------------------------------------------
   HashAggregate  (cost=7.95..8.03 rows=6 width=51) (actual time=0.254..0.259 rows=6 loops=1)
     Group Key: u.id, m.id
     Batches: 1  Memory Usage: 24kB
     Buffers: shared hit=7
     ->  Hash Left Join  (cost=4.45..7.83 rows=6 width=73) (actual time=0.229..0.246 rows=6 loops=1)
           Hash Cond: ((q.id = qa.quiz_id) AND (u.id = qa.user_id))
           ->  Hash Left Join  (cost=4.44..7.76 rows=6 width=88) (actual time=0.203..0.219 rows=6 loops=1)
                 Hash Cond: (m.id = q.module_id)
                 ->  Hash Left Join  (cost=3.30..6.60 rows=6 width=72) (actual time=0.165..0.178 rows=6 loops=1)
                       Hash Cond: ((e.id = uep.exercise_id) AND (u.id = uep.user_id))
                       ->  Hash Left Join  (cost=3.29..6.56 rows=6 width=84) (actual time=0.143..0.155 rows=6 loops=1)
                             Hash Cond: (m.id = e.module_id)
                             ->  Hash Left Join  (cost=1.15..4.34 rows=6 width=68) (actual time=0.100..0.110 rows=6 loops=1)
                                   Hash Cond: ((l.id = ulp.lesson_id) AND (u.id = ulp.user_id))
                                   ->  Nested Loop  (cost=1.14..4.29 rows=6 width=48) (actual time=0.050..0.057 rows=6 loops=1)
                                         ->  Seq Scan on users u  (actual time=0.008..0.009 rows=1 loops=1)
                                         ->  Hash Right Join  (actual time=0.039..0.045 rows=6 loops=1)
                                               Hash Cond: (l.module_id = m.id)
                                               ->  Seq Scan on lessons l  (actual time=0.004..0.004 rows=6 loops=1)
                                               ->  Hash  (actual time=0.018..0.019 rows=6 loops=1)
                                                     ->  Seq Scan on modules m  (actual time=0.004..0.005 rows=6 loops=1)
                                   ->  Hash  (actual time=0.004..0.004 rows=0 loops=1)
                                         ->  Seq Scan on user_lesson_progress ulp  (actual rows=0 loops=1)
                             ->  Hash  (actual time=0.020..0.020 rows=6 loops=1)
                                   ->  Seq Scan on exercises e  (actual time=0.004..0.007 rows=6 loops=1)
                       ->  Hash  (actual time=0.002..0.002 rows=0 loops=1)
                             ->  Seq Scan on user_exercise_progress uep  (actual rows=0 loops=1)
                 ->  Hash  (actual time=0.012..0.013 rows=6 loops=1)
                       ->  Seq Scan on quizzes q  (actual time=0.004..0.004 rows=6 loops=1)
           ->  Hash  (actual time=0.004..0.004 rows=0 loops=1)
                 ->  Seq Scan on quiz_attempts qa  (actual rows=0 loops=1)
   Planning Time: 7.433 ms
   Execution Time: 0.587 ms

The same query filtered to one user (`WHERE user_id = $1`, the shape GET /progress will
actually use) pushes the filter down into the three progress scans and runs in
**1.318 ms** (planning 7.618 ms).

Reading of the plan
-------------------
* Execution is **0.6 ms** and touches **7 shared buffers** — the entire working set is
  seven 8 KB pages, i.e. the whole curriculum fits in cache with room to spare.
* Every scan is a Seq Scan, and that is correct: with six modules and six lessons the
  planner would be wrong to use an index. The FK indexes exist for the day the tables are
  not tiny, not for this query.
* Planning (7.4 ms) costs more than an order of magnitude more than execution. That is the
  shape of a query over a dozen tiny relations, and it is why `GET /progress` should use a
  prepared statement later rather than a materialised view.
* Growth: the CROSS JOIN is users x modules, so for a solo app (1 user, 6 modules) the
  result is 6 rows forever. Even at 1,000 users it is 6,000 rows over tables measured in
  thousands of rows.

Decision: **do not materialise.** The roadmap allows materialising "only if measured
slow"; 0.6 ms is not slow, and a materialised view would add a refresh path, a staleness
window and an invalidation bug surface for no measurable gain. Re-measure in M14 when the
/ops SLI page queries it on every render, and only then if a trace shows it mattering.
-->
