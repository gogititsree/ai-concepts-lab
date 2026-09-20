-- M16: makes POST /model/runs/:id/steps idempotent.
--
-- (run_id, step_index) already looks like replay protection and is not: the server
-- allocates step_index, so a re-sent step takes the next free one and the constraint
-- never fires. Three identical posts made three rows. This is the key the *client*
-- chooses, so a retry collides with itself.
--
-- Nullable, and the unique index is a plain one: Postgres treats NULLs as distinct, so
-- every step the server writes itself (the whole agent loop) carries no key and is
-- unaffected. Existing rows backfill to NULL for the same reason -- no data migration.
ALTER TABLE "agent_run_steps" ADD COLUMN "client_step_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_steps_run_id_client_step_id_key" ON "agent_run_steps" USING btree ("run_id","client_step_id");
