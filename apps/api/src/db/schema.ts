/**
 * Drizzle definitions for the whole database, transcribed from `docs/02-schema.md`.
 *
 * All tables live in `public`. Conventions from the design doc that are enforced here:
 * uuid primary keys, `timestamptz` everywhere, snake_case column names, Postgres enums
 * for closed value sets, and an index on every foreign key (a composite index whose
 * *leading* column is the FK counts, so `sessions(user_id, revoked_at)` covers
 * `sessions.user_id`).
 *
 * The whole schema is written now, in M4, even though only a fraction of it is queried
 * before M10: later milestones then add code, not migrations, and the ERD is true from
 * the start.
 */
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  pgView,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ----------------------------------------------------------------- custom types ----

/**
 * `citext` gives case-insensitive equality and uniqueness for emails without sprinkling
 * `lower()` through every query (and without the functional index that would need).
 * Drizzle has no built-in, so the column type is declared by hand; the extension itself
 * is created by the first migration.
 */
const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});

/**
 * `bytea` for raw bytes: session ids (`sha256(token)`) and the AES-GCM pieces of the
 * TOTP secret. postgres.js maps `bytea` to/from Node `Buffer`/`Uint8Array`.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** `inet` *is* built in (drizzle-orm/pg-core), so it is re-exported rather than redefined. */
const ipAddress = inet;

// ------------------------------------------------------------------------ enums ----

export const progressStatus = pgEnum('progress_status', [
  'not_started',
  'in_progress',
  'completed',
]);

export const exerciseKind = pgEnum('exercise_kind', [
  'perceptron',
  'mlp',
  'tokenizer',
  'embeddings',
  'attention',
  'prompt',
  'structured_output',
  'agent',
  'harness',
]);

export const questionKind = pgEnum('question_kind', [
  'single_choice',
  'multi_choice',
  'numeric',
  'short_text',
]);

export const runKind = pgEnum('run_kind', ['prompt', 'structured', 'agent', 'harness']);

export const runStatus = pgEnum('run_status', [
  'running',
  'completed',
  'failed',
  'cancelled',
  'max_iterations',
]);

export const stepKind = pgEnum('step_kind', [
  'model_call',
  'tool_call',
  'tool_result',
  'final',
  'error',
]);

export const authEventType = pgEnum('auth_event_type', [
  'register',
  'login_success',
  'login_failed',
  'lockout',
  'mfa_challenge',
  'mfa_success',
  'mfa_failed',
  'mfa_enrolled',
  'mfa_disabled',
  'backup_code_used',
  'backup_codes_regenerated',
  'password_changed',
  'logout',
  'session_revoked',
]);

// -------------------------------------------------------------- identity & auth ----

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull().unique(),
  /** argon2id encoded string: algorithm, parameters and salt are inside it. */
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  /**
   * Denormalised from `mfa_totp.confirmed_at IS NOT NULL`. Every authenticated request
   * reads it to decide whether a session must be MFA-verified, so it is worth the
   * duplication; the MFA routes are the only writers.
   */
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  /** Soft lockout after 10 failures (15 minutes). */
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One row per user; the row exists during enrollment, before `confirmed_at` is set. */
export const mfaTotp = pgTable('mfa_totp', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  secretCiphertext: bytea('secret_ciphertext').notNull(),
  /** 12 bytes. */
  secretIv: bytea('secret_iv').notNull(),
  /** 16-byte GCM auth tag. */
  secretTag: bytea('secret_tag').notNull(),
  keyVersion: smallint('key_version').notNull().default(1),
  /** NULL = enrollment pending; pending rows older than 1 h are deleted. */
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  /** TOTP counter of the last accepted code; `step <= last_used_step` is a replay. */
  lastUsedStep: bigint('last_used_step', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const mfaBackupCodes = pgTable(
  'mfa_backup_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    /** Single use. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('mfa_backup_codes_user_id_idx').on(table.userId)],
);

export const sessions = pgTable(
  'sessions',
  {
    /** `sha256(token)`. The raw 32-byte token only ever exists in the `sid` cookie. */
    id: bytea('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** NULL on a *pending* session: login step 1 done, TOTP not yet verified. */
    mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ip: ipAddress('ip'),
    userAgent: text('user_agent'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    index('sessions_user_id_revoked_at_idx').on(table.userId, table.revokedAt),
    // The cleanup job deletes by expiry, so that scan gets its own index.
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
);

/** Append-only audit log. Never store secrets, passwords or codes in `metadata`. */
export const authEvents = pgTable(
  'auth_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** NULL for failed logins against an unknown email. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    eventType: authEventType('event_type').notNull(),
    ip: ipAddress('ip'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('auth_events_user_id_created_at_idx').on(table.userId, table.createdAt.desc()),
    index('auth_events_event_type_created_at_idx').on(table.eventType, table.createdAt.desc()),
  ],
);

// ------------------------------------------------------------ curriculum content ----

export const modules = pgTable('modules', {
  /** uuid v5 from the slug, so re-seeding is idempotent and ids are stable across DBs. */
  id: uuid('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  orderIndex: integer('order_index').notNull().unique(),
  /** True for modules 4–6; the UI shows the "run locally" banner. */
  requiresModel: boolean('requires_model').notNull().default(false),
  isPublished: boolean('is_published').notNull().default(true),
  /** Bumped by the seed when a module's content files actually change. */
  contentVersion: integer('content_version').notNull(),
});

export const lessons = pgTable(
  'lessons',
  {
    /** uuid v5 from `module slug + lesson slug`. */
    id: uuid('id').primaryKey(),
    moduleId: uuid('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    orderIndex: integer('order_index').notNull(),
    /** Markdown, rendered client-side with react-markdown + KaTeX. */
    bodyMd: text('body_md').notNull(),
    estimatedMinutes: integer('estimated_minutes').notNull().default(10),
  },
  (table) => [
    uniqueIndex('lessons_module_id_slug_key').on(table.moduleId, table.slug),
    uniqueIndex('lessons_module_id_order_index_key').on(table.moduleId, table.orderIndex),
  ],
);

export const exercises = pgTable(
  'exercises',
  {
    id: uuid('id').primaryKey(),
    moduleId: uuid('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    /** Optional anchor: "this exercise appears after lesson X". */
    lessonId: uuid('lesson_id').references(() => lessons.id, { onDelete: 'set null' }),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    /** Selects the React component. */
    kind: exerciseKind('kind').notNull(),
    /**
     * Kind-specific authored configuration (datasets, default weights, tool subsets,
     * task list with auto-check rules). jsonb because it is hierarchical, authored, and
     * never queried by its inner fields; validated by a Zod schema per kind in
     * `packages/shared`.
     */
    config: jsonb('config').notNull(),
    orderIndex: integer('order_index').notNull(),
    /** e.g. `{"type":"tasks","required":2}`; interpreted server-side on progress writes. */
    completionRule: jsonb('completion_rule').notNull(),
  },
  (table) => [
    uniqueIndex('exercises_module_id_slug_key').on(table.moduleId, table.slug),
    index('exercises_lesson_id_idx').on(table.lessonId),
  ],
);

export const quizzes = pgTable('quizzes', {
  id: uuid('id').primaryKey(),
  /** UNIQUE: exactly one quiz per module. */
  moduleId: uuid('module_id')
    .notNull()
    .unique()
    .references(() => modules.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  /** Fraction correct required to pass. */
  passThreshold: numeric('pass_threshold', { precision: 3, scale: 2 }).notNull().default('0.7'),
});

export const quizQuestions = pgTable(
  'quiz_questions',
  {
    id: uuid('id').primaryKey(),
    quizId: uuid('quiz_id')
      .notNull()
      .references(() => quizzes.id, { onDelete: 'cascade' }),
    orderIndex: integer('order_index').notNull(),
    kind: questionKind('kind').notNull(),
    promptMd: text('prompt_md').notNull(),
    /** `[{id:'a', text_md:'...'}, ...]` for the choice kinds; NULL otherwise. */
    options: jsonb('options'),
    /**
     * Never serialised by `GET /quizzes/:id` (access rule enforced in the route and
     * tested in M7). Shape depends on `kind`.
     */
    correct: jsonb('correct').notNull(),
    explanationMd: text('explanation_md').notNull(),
    points: integer('points').notNull().default(1),
  },
  (table) => [
    uniqueIndex('quiz_questions_quiz_id_order_index_key').on(table.quizId, table.orderIndex),
  ],
);

// ----------------------------------------------------------------- learner progress ----

export const userLessonProgress = pgTable(
  'user_lesson_progress',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lessonId: uuid('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    status: progressStatus('status').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.lessonId] }),
    // The PK covers lookups by user; "who completed this lesson" needs the other order.
    index('user_lesson_progress_lesson_id_idx').on(table.lessonId),
  ],
);

export const userExerciseProgress = pgTable(
  'user_exercise_progress',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    exerciseId: uuid('exercise_id')
      .notNull()
      .references(() => exercises.id, { onDelete: 'cascade' }),
    status: progressStatus('status').notNull(),
    /** The learner's saved work; ≤ 64 KB, validated per exercise kind. */
    state: jsonb('state'),
    /** Task ids from `exercises.config.tasks` that passed their auto-check. */
    tasksCompleted: text('tasks_completed')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.exerciseId] }),
    index('user_exercise_progress_exercise_id_idx').on(table.exerciseId),
  ],
);

export const quizAttempts = pgTable(
  'quiz_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    quizId: uuid('quiz_id')
      .notNull()
      .references(() => quizzes.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    /** Attempts are submitted atomically; no partial attempts are stored. */
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    scorePoints: integer('score_points').notNull(),
    maxPoints: integer('max_points').notNull(),
    /** Denormalised: the pass rule may change later without rewriting history. */
    passed: boolean('passed').notNull(),
  },
  (table) => [
    index('quiz_attempts_user_id_quiz_id_submitted_at_idx').on(
      table.userId,
      table.quizId,
      table.submittedAt.desc(),
    ),
    index('quiz_attempts_quiz_id_idx').on(table.quizId),
  ],
);

export const quizAttemptAnswers = pgTable(
  'quiz_attempt_answers',
  {
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => quizAttempts.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id')
      .notNull()
      .references(() => quizQuestions.id, { onDelete: 'cascade' }),
    /** Same shape family as `quiz_questions.correct`. */
    answer: jsonb('answer').notNull(),
    isCorrect: boolean('is_correct').notNull(),
    pointsAwarded: integer('points_awarded').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.attemptId, table.questionId] }),
    index('quiz_attempt_answers_question_id_idx').on(table.questionId),
  ],
);

// ------------------------------------------------------ agent / model observability ----

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** NULL for a free-form playground run. */
    exerciseId: uuid('exercise_id').references(() => exercises.id, { onDelete: 'set null' }),
    kind: runKind('kind').notNull(),
    /** `ollama` / `fake`. */
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    status: runStatus('status').notNull(),
    systemPrompt: text('system_prompt').notNull(),
    userPrompt: text('user_prompt').notNull(),
    /** ToolDefinition[] exactly as sent to the model. */
    tools: jsonb('tools').notNull().default([]),
    options: jsonb('options').notNull().default({}),
    maxIterations: integer('max_iterations').notNull(),
    iterationCount: integer('iteration_count').notNull().default(0),
    // Rollups so `/ops/sli` never has to scan agent_run_steps.
    toolCallCount: integer('tool_call_count').notNull().default(0),
    toolParseFailureCount: integer('tool_parse_failure_count').notNull().default(0),
    promptTokensTotal: integer('prompt_tokens_total').notNull().default(0),
    completionTokensTotal: integer('completion_tokens_total').notNull().default(0),
    modelLatencyMsTotal: integer('model_latency_ms_total').notNull().default(0),
    finalOutput: text('final_output'),
    /** `MODEL_TIMEOUT`, `MODEL_UNAVAILABLE`, `TOOL_ERROR`, … */
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** Correlates a run with the pino log lines for the request that started it. */
    requestId: text('request_id').notNull(),
  },
  (table) => [
    index('agent_runs_user_id_started_at_idx').on(table.userId, table.startedAt.desc()),
    index('agent_runs_status_started_at_idx').on(table.status, table.startedAt),
    index('agent_runs_exercise_id_idx').on(table.exerciseId),
  ],
);

export const agentRunSteps = pgTable(
  'agent_run_steps',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    /** 0-based, monotonic within a run. Allocated by the server, never by the client. */
    stepIndex: integer('step_index').notNull(),
    /**
     * The client's own name for this step, for `POST /model/runs/:id/steps` (M16).
     *
     * NULL for every step the server writes itself, and that is load-bearing: Postgres
     * treats NULLs as distinct in a unique index, so the agent loop can write thousands
     * of rows with no key while the client-reported ones are deduplicated. The
     * alternative — a sentinel value — would make the unique index fire on the second
     * server-written step of every run.
     */
    clientStepId: text('client_step_id'),
    kind: stepKind('kind').notNull(),
    iteration: integer('iteration').notNull(),
    /** Assistant text (model_call / final) or the error text. */
    content: text('content'),
    toolName: text('tool_name'),
    toolArgs: jsonb('tool_args'),
    /** The raw string when argument parsing failed or had to be recovered. */
    toolArgsRaw: text('tool_args_raw'),
    parseOk: boolean('parse_ok'),
    toolResult: jsonb('tool_result'),
    isError: boolean('is_error').notNull().default(false),
    /** model_call: inference time; tool_result: tool execution time. */
    latencyMs: integer('latency_ms'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    /** Provider response metadata (Ollama timings); ≤ 32 KB, truncated with a flag. */
    raw: jsonb('raw'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('agent_run_steps_run_id_step_index_key').on(table.runId, table.stepIndex),
    /**
     * What makes `POST /model/runs/:id/steps` idempotent. The `(run_id, step_index)`
     * index above cannot do it — the server picks `step_index`, so a replayed step just
     * gets the next free one. This constraint is the guarantee; the handler's
     * `ON CONFLICT DO NOTHING` is only how it asks for it politely.
     */
    uniqueIndex('agent_run_steps_run_id_client_step_id_key').on(table.runId, table.clientStepId),
  ],
);

// ------------------------------------------------------------------------- view ----

/**
 * `v_user_module_progress` — per (user, module) rollup, computed rather than stored.
 * The CROSS JOIN means every user has a row for every module, including modules they
 * have never opened (all counters zero), which is exactly what the modules list needs.
 *
 * Defined with raw SQL because the shape is not expressible through the query builder in
 * a way that round-trips. drizzle-kit **does** emit it into the generated migration
 * (`CREATE VIEW "v_user_module_progress" AS (...)`), so no hand-editing was needed for
 * the view itself — only for the two extensions, which drizzle-kit has no concept of.
 *
 * **Why lateral subqueries and not the one flat GROUP BY in docs/02-schema.md** (see
 * `docs/adr/0001-fix-v-user-module-progress-fan-out.md`): joining lessons, exercises and
 * quiz_attempts in a single FROM multiplies the rows, so `count(l.id)` returned
 * lessons × attempts. A learner with three lessons and two quiz attempts was reported as
 * having "6 of 6 lessons". Each fact is now aggregated over its own rows.
 *
 * What deliberately did *not* change: `bool_or` over zero rows is still SQL NULL, so an
 * untouched module still reports `exercise_done = NULL`. Coalescing is the API's job
 * (`content/repository.ts`), which keeps the view a faithful report of what is known.
 */
export const vUserModuleProgress = pgView('v_user_module_progress', {
  userId: uuid('user_id').notNull(),
  moduleId: uuid('module_id').notNull(),
  lessonsTotal: bigint('lessons_total', { mode: 'number' }).notNull(),
  lessonsDone: bigint('lessons_done', { mode: 'number' }).notNull(),
  exerciseDone: boolean('exercise_done'),
  quizPassed: boolean('quiz_passed'),
  moduleCompleted: boolean('module_completed'),
}).as(
  sql`SELECT u.id AS user_id, m.id AS module_id,
       agg.lessons_total,
       agg.lessons_done,
       agg.exercise_done,
       agg.quiz_passed,
       (agg.lessons_total = agg.lessons_done AND agg.exercise_done AND agg.quiz_passed) AS module_completed
FROM users u
CROSS JOIN modules m
CROSS JOIN LATERAL (
  SELECT
    (SELECT count(*) FROM lessons l WHERE l.module_id = m.id) AS lessons_total,
    (SELECT count(*) FROM lessons l
       JOIN user_lesson_progress ulp ON ulp.lesson_id = l.id AND ulp.user_id = u.id
      WHERE l.module_id = m.id AND ulp.status = 'completed') AS lessons_done,
    (SELECT bool_or(uep.status = 'completed') FROM exercises e
       JOIN user_exercise_progress uep ON uep.exercise_id = e.id AND uep.user_id = u.id
      WHERE e.module_id = m.id) AS exercise_done,
    (SELECT bool_or(qa.passed) FROM quizzes q
       JOIN quiz_attempts qa ON qa.quiz_id = q.id AND qa.user_id = u.id
      WHERE q.module_id = m.id) AS quiz_passed
) agg`,
);
