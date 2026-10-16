-- M6: question set integrity. Hand-written: drizzle-kit does not model triggers. IDEMPOTENT on purpose (DROP TRIGGER IF EXISTS, CREATE OR REPLACE FUNCTION):
-- the documented recovery of docs/MIGRATIONS.md section 6.4 may re-run it together with 0020.
-- A question set is a historical record of what the question engine produced for ONE verified assessment. Normal application paths (and direct SQL)
-- cannot rewrite or erase it; an administrator can still run an explicit, reviewed data migration by disabling these triggers inside it.
-- The existing `assessment_immutable_guard` and `assessment_no_truncate` functions (migration 0011) are reused: same rule, same error.

-- 1. Append-only ----------------------------------------------------------------------------------------------------------------------
DROP TRIGGER IF EXISTS "question_sets_immutable_guard" ON "question_sets";
--> statement-breakpoint
CREATE TRIGGER "question_sets_immutable_guard" BEFORE UPDATE OR DELETE ON "question_sets"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "question_set_opportunities_immutable_guard" ON "question_set_opportunities";
--> statement-breakpoint
CREATE TRIGGER "question_set_opportunities_immutable_guard" BEFORE UPDATE OR DELETE ON "question_set_opportunities"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "question_set_questions_immutable_guard" ON "question_set_questions";
--> statement-breakpoint
CREATE TRIGGER "question_set_questions_immutable_guard" BEFORE UPDATE OR DELETE ON "question_set_questions"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "question_sets_no_truncate" ON "question_sets";
--> statement-breakpoint
CREATE TRIGGER "question_sets_no_truncate" BEFORE TRUNCATE ON "question_sets"
  FOR EACH STATEMENT EXECUTE FUNCTION "assessment_no_truncate"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "question_set_opportunities_no_truncate" ON "question_set_opportunities";
--> statement-breakpoint
CREATE TRIGGER "question_set_opportunities_no_truncate" BEFORE TRUNCATE ON "question_set_opportunities"
  FOR EACH STATEMENT EXECUTE FUNCTION "assessment_no_truncate"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "question_set_questions_no_truncate" ON "question_set_questions";
--> statement-breakpoint
CREATE TRIGGER "question_set_questions_no_truncate" BEFORE TRUNCATE ON "question_set_questions"
  FOR EACH STATEMENT EXECUTE FUNCTION "assessment_no_truncate"();
--> statement-breakpoint

-- 2. Ownership: a set is tied to exactly the assessment it was derived from ---------------------------------------------------------------
-- (the composite foreign key already proves the assessment belongs to the same project)
CREATE OR REPLACE FUNCTION "question_sets_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_assessment "pre_interview_assessments"%ROWTYPE;
BEGIN
  SELECT * INTO v_assessment FROM "pre_interview_assessments" WHERE id = NEW.assessment_id AND project_id = NEW.project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a question set must belong to an assessment of its own project' USING ERRCODE = 'check_violation';
  END IF;
  IF v_assessment.output_hash <> NEW.report_output_hash
     OR v_assessment.context_version_id <> NEW.context_version_id
     OR v_assessment.extraction_id <> NEW.extraction_id THEN
    RAISE EXCEPTION 'the question set disagrees with the assessment it was derived from (report hash, context version or extraction)' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "project_voids" WHERE project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'a voided project cannot receive a question set' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "question_sets_guard" ON "question_sets";
--> statement-breakpoint
CREATE TRIGGER "question_sets_guard" BEFORE INSERT ON "question_sets"
  FOR EACH ROW EXECUTE FUNCTION "question_sets_guard"();
--> statement-breakpoint

-- 3. Completeness, checked at commit: a set has exactly the opportunities and questions it declares, ranks and ordinals are gapless,
--    and every question points at opportunities of ITS OWN set. A row added to a committed set later fails this check.
CREATE OR REPLACE FUNCTION "question_set_completeness_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_set uuid;
  v_row "question_sets"%ROWTYPE;
  v_opportunities integer;
  v_max_ordinal integer;
  v_questions integer;
  v_max_rank integer;
  v_dangling integer;
BEGIN
  -- plpgsql resolves a record's fields when it plans an expression, so each table's row is read in its own branch
  IF TG_TABLE_NAME = 'question_sets' THEN
    v_set := NEW.id;
  ELSIF TG_TABLE_NAME = 'question_set_opportunities' THEN
    v_set := NEW.set_id;
  ELSE
    v_set := NEW.set_id;
  END IF;
  SELECT * INTO v_row FROM "question_sets" WHERE id = v_set;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'question set % does not exist', v_set USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*), coalesce(max(ordinal), 0) INTO v_opportunities, v_max_ordinal FROM "question_set_opportunities" WHERE set_id = v_set;
  SELECT count(*), coalesce(max(rank), 0) INTO v_questions, v_max_rank FROM "question_set_questions" WHERE set_id = v_set;
  IF v_opportunities <> v_row.opportunity_count OR v_max_ordinal <> v_row.opportunity_count THEN
    RAISE EXCEPTION 'question set % must hold exactly its % declared opportunities, numbered 1..n', v_set, v_row.opportunity_count USING ERRCODE = 'check_violation';
  END IF;
  IF v_questions <> v_row.selected_count OR v_max_rank <> v_row.selected_count THEN
    RAISE EXCEPTION 'question set % must hold exactly its % declared questions, ranked 1..n', v_set, v_row.selected_count USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO v_dangling
    FROM "question_set_questions" q, jsonb_array_elements_text(q.opportunity_keys) AS k(key)
   WHERE q.set_id = v_set
     AND NOT EXISTS (SELECT 1 FROM "question_set_opportunities" o WHERE o.set_id = v_set AND o.opportunity_key = k.key);
  IF v_dangling > 0 THEN
    RAISE EXCEPTION 'question set % has a question that cites an opportunity outside the set', v_set USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "question_sets_complete" ON "question_sets";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "question_sets_complete" AFTER INSERT ON "question_sets"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "question_set_completeness_check"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "question_set_opportunities_complete" ON "question_set_opportunities";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "question_set_opportunities_complete" AFTER INSERT ON "question_set_opportunities"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "question_set_completeness_check"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "question_set_questions_complete" ON "question_set_questions";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "question_set_questions_complete" AFTER INSERT ON "question_set_questions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "question_set_completeness_check"();
