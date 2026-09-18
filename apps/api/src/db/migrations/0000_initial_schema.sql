-- Hand-added (drizzle-kit has no notion of extensions): everything below depends on
-- these two. `citext` gives users.email case-insensitive uniqueness; `pgcrypto`
-- provides gen_random_uuid(), the DEFAULT on every non-content primary key.
CREATE EXTENSION IF NOT EXISTS "citext";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE TYPE "public"."auth_event_type" AS ENUM('register', 'login_success', 'login_failed', 'lockout', 'mfa_challenge', 'mfa_success', 'mfa_failed', 'mfa_enrolled', 'mfa_disabled', 'backup_code_used', 'backup_codes_regenerated', 'password_changed', 'logout', 'session_revoked');--> statement-breakpoint
CREATE TYPE "public"."exercise_kind" AS ENUM('perceptron', 'mlp', 'tokenizer', 'embeddings', 'attention', 'prompt', 'structured_output', 'agent', 'harness');--> statement-breakpoint
CREATE TYPE "public"."progress_status" AS ENUM('not_started', 'in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "public"."question_kind" AS ENUM('single_choice', 'multi_choice', 'numeric', 'short_text');--> statement-breakpoint
CREATE TYPE "public"."run_kind" AS ENUM('prompt', 'structured', 'agent', 'harness');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'completed', 'failed', 'cancelled', 'max_iterations');--> statement-breakpoint
CREATE TYPE "public"."step_kind" AS ENUM('model_call', 'tool_call', 'tool_result', 'final', 'error');--> statement-breakpoint
CREATE TABLE "agent_run_steps" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"kind" "step_kind" NOT NULL,
	"iteration" integer NOT NULL,
	"content" text,
	"tool_name" text,
	"tool_args" jsonb,
	"tool_args_raw" text,
	"parse_ok" boolean,
	"tool_result" jsonb,
	"is_error" boolean DEFAULT false NOT NULL,
	"latency_ms" integer,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"exercise_id" uuid,
	"kind" "run_kind" NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" "run_status" NOT NULL,
	"system_prompt" text NOT NULL,
	"user_prompt" text NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"max_iterations" integer NOT NULL,
	"iteration_count" integer DEFAULT 0 NOT NULL,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"tool_parse_failure_count" integer DEFAULT 0 NOT NULL,
	"prompt_tokens_total" integer DEFAULT 0 NOT NULL,
	"completion_tokens_total" integer DEFAULT 0 NOT NULL,
	"model_latency_ms_total" integer DEFAULT 0 NOT NULL,
	"final_output" text,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"request_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"event_type" "auth_event_type" NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exercises" (
	"id" uuid PRIMARY KEY NOT NULL,
	"module_id" uuid NOT NULL,
	"lesson_id" uuid,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"kind" "exercise_kind" NOT NULL,
	"config" jsonb NOT NULL,
	"order_index" integer NOT NULL,
	"completion_rule" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lessons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"module_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"order_index" integer NOT NULL,
	"body_md" text NOT NULL,
	"estimated_minutes" integer DEFAULT 10 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mfa_backup_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mfa_totp" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"secret_ciphertext" "bytea" NOT NULL,
	"secret_iv" "bytea" NOT NULL,
	"secret_tag" "bytea" NOT NULL,
	"key_version" smallint DEFAULT 1 NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_used_step" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "modules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"order_index" integer NOT NULL,
	"requires_model" boolean DEFAULT false NOT NULL,
	"is_published" boolean DEFAULT true NOT NULL,
	"content_version" integer NOT NULL,
	CONSTRAINT "modules_slug_unique" UNIQUE("slug"),
	CONSTRAINT "modules_order_index_unique" UNIQUE("order_index")
);
--> statement-breakpoint
CREATE TABLE "quiz_attempt_answers" (
	"attempt_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"answer" jsonb NOT NULL,
	"is_correct" boolean NOT NULL,
	"points_awarded" integer NOT NULL,
	CONSTRAINT "quiz_attempt_answers_attempt_id_question_id_pk" PRIMARY KEY("attempt_id","question_id")
);
--> statement-breakpoint
CREATE TABLE "quiz_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"quiz_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"score_points" integer NOT NULL,
	"max_points" integer NOT NULL,
	"passed" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quiz_questions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"quiz_id" uuid NOT NULL,
	"order_index" integer NOT NULL,
	"kind" "question_kind" NOT NULL,
	"prompt_md" text NOT NULL,
	"options" jsonb,
	"correct" jsonb NOT NULL,
	"explanation_md" text NOT NULL,
	"points" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quizzes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"module_id" uuid NOT NULL,
	"title" text NOT NULL,
	"pass_threshold" numeric(3, 2) DEFAULT '0.7' NOT NULL,
	CONSTRAINT "quizzes_module_id_unique" UNIQUE("module_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" "bytea" PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"mfa_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_exercise_progress" (
	"user_id" uuid NOT NULL,
	"exercise_id" uuid NOT NULL,
	"status" "progress_status" NOT NULL,
	"state" jsonb,
	"tasks_completed" text[] DEFAULT '{}'::text[] NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_exercise_progress_user_id_exercise_id_pk" PRIMARY KEY("user_id","exercise_id")
);
--> statement-breakpoint
CREATE TABLE "user_lesson_progress" (
	"user_id" uuid NOT NULL,
	"lesson_id" uuid NOT NULL,
	"status" "progress_status" NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_lesson_progress_user_id_lesson_id_pk" PRIMARY KEY("user_id","lesson_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "agent_run_steps" ADD CONSTRAINT "agent_run_steps_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_events" ADD CONSTRAINT "auth_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_backup_codes" ADD CONSTRAINT "mfa_backup_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_totp" ADD CONSTRAINT "mfa_totp_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempt_answers" ADD CONSTRAINT "quiz_attempt_answers_attempt_id_quiz_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."quiz_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempt_answers" ADD CONSTRAINT "quiz_attempt_answers_question_id_quiz_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."quiz_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_exercise_progress" ADD CONSTRAINT "user_exercise_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_exercise_progress" ADD CONSTRAINT "user_exercise_progress_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_lesson_progress" ADD CONSTRAINT "user_lesson_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_lesson_progress" ADD CONSTRAINT "user_lesson_progress_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_steps_run_id_step_index_key" ON "agent_run_steps" USING btree ("run_id","step_index");--> statement-breakpoint
CREATE INDEX "agent_runs_user_id_started_at_idx" ON "agent_runs" USING btree ("user_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_runs_status_started_at_idx" ON "agent_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "agent_runs_exercise_id_idx" ON "agent_runs" USING btree ("exercise_id");--> statement-breakpoint
CREATE INDEX "auth_events_user_id_created_at_idx" ON "auth_events" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auth_events_event_type_created_at_idx" ON "auth_events" USING btree ("event_type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "exercises_module_id_slug_key" ON "exercises" USING btree ("module_id","slug");--> statement-breakpoint
CREATE INDEX "exercises_lesson_id_idx" ON "exercises" USING btree ("lesson_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lessons_module_id_slug_key" ON "lessons" USING btree ("module_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "lessons_module_id_order_index_key" ON "lessons" USING btree ("module_id","order_index");--> statement-breakpoint
CREATE INDEX "mfa_backup_codes_user_id_idx" ON "mfa_backup_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "quiz_attempt_answers_question_id_idx" ON "quiz_attempt_answers" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "quiz_attempts_user_id_quiz_id_submitted_at_idx" ON "quiz_attempts" USING btree ("user_id","quiz_id","submitted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "quiz_attempts_quiz_id_idx" ON "quiz_attempts" USING btree ("quiz_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quiz_questions_quiz_id_order_index_key" ON "quiz_questions" USING btree ("quiz_id","order_index");--> statement-breakpoint
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "user_exercise_progress_exercise_id_idx" ON "user_exercise_progress" USING btree ("exercise_id");--> statement-breakpoint
CREATE INDEX "user_lesson_progress_lesson_id_idx" ON "user_lesson_progress" USING btree ("lesson_id");--> statement-breakpoint
CREATE VIEW "public"."v_user_module_progress" AS (SELECT u.id AS user_id, m.id AS module_id,
       count(l.id) AS lessons_total,
       count(ulp.lesson_id) FILTER (WHERE ulp.status = 'completed') AS lessons_done,
       bool_or(uep.status = 'completed') AS exercise_done,
       bool_or(qa.passed) AS quiz_passed,
       (count(l.id) = count(ulp.lesson_id) FILTER (WHERE ulp.status = 'completed')
        AND bool_or(uep.status = 'completed') AND bool_or(qa.passed)) AS module_completed
FROM users u CROSS JOIN modules m
LEFT JOIN lessons l ON l.module_id = m.id
LEFT JOIN user_lesson_progress ulp ON ulp.lesson_id = l.id AND ulp.user_id = u.id
LEFT JOIN exercises e ON e.module_id = m.id
LEFT JOIN user_exercise_progress uep ON uep.exercise_id = e.id AND uep.user_id = u.id
LEFT JOIN quizzes q ON q.module_id = m.id
LEFT JOIN quiz_attempts qa ON qa.quiz_id = q.id AND qa.user_id = u.id
GROUP BY u.id, m.id);