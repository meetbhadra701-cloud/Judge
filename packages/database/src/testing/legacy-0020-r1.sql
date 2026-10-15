CREATE TABLE "assessment_run_coverage" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"schema_id" text NOT NULL,
	"selection_policy" text NOT NULL,
	"verdict" text NOT NULL,
	"record_canonical" text NOT NULL,
	"record_sha256" text NOT NULL,
	"record" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_run_coverage_hash_hex" CHECK (record_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assessment_run_coverage_verdict_valid" CHECK (verdict IN ('complete', 'partial', 'insufficient')),
	CONSTRAINT "assessment_run_coverage_text_bounded" CHECK (char_length(record_canonical) BETWEEN 2 AND 4000000),
	CONSTRAINT "assessment_run_coverage_hash_matches_text" CHECK (record_sha256 = encode(sha256(convert_to(record_canonical, 'UTF8')), 'hex'))
);
--> statement-breakpoint
ALTER TABLE "assessment_run_coverage" ADD CONSTRAINT "assessment_run_coverage_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_run_coverage" ADD CONSTRAINT "assessment_run_coverage_run_same_project_fk" FOREIGN KEY ("run_id","project_id") REFERENCES "public"."analysis_runs"("id","project_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Hand-written (drizzle-kit does not emit triggers): the coverage record is an append-only historical record of what a run's selection did.
CREATE TRIGGER "assessment_run_coverage_immutable_guard" BEFORE UPDATE OR DELETE ON "assessment_run_coverage"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
--> statement-breakpoint
CREATE TRIGGER "assessment_run_coverage_no_truncate" BEFORE TRUNCATE ON "assessment_run_coverage"
  FOR EACH STATEMENT EXECUTE FUNCTION "assessment_no_truncate"();
--> statement-breakpoint
CREATE FUNCTION "assessment_run_coverage_insert_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_state text;
BEGIN
  SELECT state INTO v_state FROM "analysis_runs" WHERE id = NEW.run_id;
  IF v_state IS DISTINCT FROM 'running' THEN
    RAISE EXCEPTION 'a coverage record can only be written while its run is running' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.record_canonical::jsonb IS DISTINCT FROM NEW.record THEN
    RAISE EXCEPTION 'the coverage record mirror differs from its canonical text' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.record->>'schema' IS DISTINCT FROM NEW.schema_id
     OR NEW.record->>'verdict' IS DISTINCT FROM NEW.verdict
     OR NEW.record->'policy'->>'selection' IS DISTINCT FROM NEW.selection_policy THEN
    RAISE EXCEPTION 'the coverage record columns differ from the record' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assessment_run_coverage_insert_guard" BEFORE INSERT ON "assessment_run_coverage"
  FOR EACH ROW EXECUTE FUNCTION "assessment_run_coverage_insert_guard"();
