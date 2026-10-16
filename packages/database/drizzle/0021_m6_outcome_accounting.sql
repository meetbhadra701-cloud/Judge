-- M6 phase 0 (R8B P3-4). IDEMPOTENT on purpose (the documented recovery of docs/MIGRATIONS.md section 6.4 may re-run it together with 0020).
-- Additive: no row is deleted or rewritten; earlier runs keep NULL ("not recorded") in the two new columns.
ALTER TABLE "assessment_run_outcomes" ADD COLUMN IF NOT EXISTS "stage_executions" integer;--> statement-breakpoint
ALTER TABLE "assessment_run_outcomes" ADD COLUMN IF NOT EXISTS "provider_calls" integer;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assessment_run_outcomes_provider_calls_live_only' AND conrelid = 'public.assessment_run_outcomes'::regclass) THEN
    ALTER TABLE "assessment_run_outcomes" ADD CONSTRAINT "assessment_run_outcomes_provider_calls_live_only" CHECK (provider_calls IS NULL OR (provider_calls >= 0 AND (provider_calls = 0 OR provider_mode = 'live')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assessment_run_outcomes_stage_executions_match' AND conrelid = 'public.assessment_run_outcomes'::regclass) THEN
    ALTER TABLE "assessment_run_outcomes" ADD CONSTRAINT "assessment_run_outcomes_stage_executions_match" CHECK (stage_executions IS NULL OR stage_executions = attempts_started);
  END IF;
END
$$;
--> statement-breakpoint
-- Hand-written documentation of what the historical counters mean. COMMENT is idempotent.
COMMENT ON COLUMN "assessment_run_outcomes"."attempts_started" IS 'LEDGER entries of the run = local stage executions. For a live provider each is one provider call; for a replay or scripted demonstration each is a pass of local code and NO model was called (see provider_calls).';
--> statement-breakpoint
COMMENT ON COLUMN "assessment_run_outcomes"."settled_calls" IS 'Ledger entries settled (stage executions that finished). NOT a count of provider calls unless provider_mode is live.';
--> statement-breakpoint
COMMENT ON COLUMN "assessment_run_outcomes"."stage_executions" IS 'Local stage executions (equals attempts_started); NULL for runs recorded before M6.';
--> statement-breakpoint
COMMENT ON COLUMN "assessment_run_outcomes"."provider_calls" IS 'External provider invocations; always 0 unless provider_mode is live; NULL for runs recorded before M6.';
