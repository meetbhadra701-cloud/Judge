-- M5 P4: assessment integrity. Hand-written: drizzle-kit does not model triggers.
-- Assessments, run pins, extraction membership and the call ledger are historical records. Normal application paths (and direct SQL)
-- cannot rewrite or erase them; an administrator can still run an explicit, reviewed data migration by disabling these triggers inside it.
-- Lock order used by every writer: project row (FOR NO KEY UPDATE) -> pinned event_context_versions row (FOR SHARE) -> analysis_runs row
-- -> assessment_run_budget row (FOR UPDATE). A reader never takes a row lock.

-- 1. Append-only tables ---------------------------------------------------------------------------------------------------------
CREATE FUNCTION "assessment_immutable_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable historical records; create a new record instead', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "assessment_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% cannot be truncated: assessment records are append-only', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assessment_requests_immutable_guard" BEFORE UPDATE OR DELETE ON "assessment_requests"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
--> statement-breakpoint
CREATE TRIGGER "assessment_run_inputs_immutable_guard" BEFORE UPDATE OR DELETE ON "assessment_run_inputs"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
--> statement-breakpoint
CREATE TRIGGER "assessment_run_input_snapshots_immutable_guard" BEFORE UPDATE OR DELETE ON "assessment_run_input_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
--> statement-breakpoint
CREATE TRIGGER "assessment_run_budget_immutable_guard" BEFORE UPDATE OR DELETE ON "assessment_run_budget"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
--> statement-breakpoint
CREATE TRIGGER "assessment_run_outcomes_immutable_guard" BEFORE UPDATE OR DELETE ON "assessment_run_outcomes"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
--> statement-breakpoint
CREATE TRIGGER "assessment_run_extractions_immutable_guard" BEFORE UPDATE OR DELETE ON "assessment_run_extractions"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
--> statement-breakpoint
CREATE TRIGGER "graph_extractions_immutable_guard" BEFORE UPDATE OR DELETE ON "graph_extractions"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
--> statement-breakpoint
CREATE TRIGGER "graph_extraction_items_immutable_guard" BEFORE UPDATE OR DELETE ON "graph_extraction_items"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
--> statement-breakpoint
CREATE TRIGGER "pre_interview_assessments_immutable_guard" BEFORE UPDATE OR DELETE ON "pre_interview_assessments"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
--> statement-breakpoint
CREATE TRIGGER "assessment_dimension_judgments_immutable_guard" BEFORE UPDATE OR DELETE ON "assessment_dimension_judgments"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
--> statement-breakpoint
CREATE TRIGGER "assessment_judgment_citations_immutable_guard" BEFORE UPDATE OR DELETE ON "assessment_judgment_citations"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
--> statement-breakpoint
CREATE TRIGGER "assessment_requests_no_truncate" BEFORE TRUNCATE ON "assessment_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION "assessment_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "assessment_run_inputs_no_truncate" BEFORE TRUNCATE ON "assessment_run_inputs"
  FOR EACH STATEMENT EXECUTE FUNCTION "assessment_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "assessment_run_input_snapshots_no_truncate" BEFORE TRUNCATE ON "assessment_run_input_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION "assessment_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "assessment_run_budget_no_truncate" BEFORE TRUNCATE ON "assessment_run_budget"
  FOR EACH STATEMENT EXECUTE FUNCTION "assessment_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "assessment_run_calls_no_truncate" BEFORE TRUNCATE ON "assessment_run_calls"
  FOR EACH STATEMENT EXECUTE FUNCTION "assessment_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "assessment_run_outcomes_no_truncate" BEFORE TRUNCATE ON "assessment_run_outcomes"
  FOR EACH STATEMENT EXECUTE FUNCTION "assessment_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "assessment_run_extractions_no_truncate" BEFORE TRUNCATE ON "assessment_run_extractions"
  FOR EACH STATEMENT EXECUTE FUNCTION "assessment_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "graph_extractions_no_truncate" BEFORE TRUNCATE ON "graph_extractions"
  FOR EACH STATEMENT EXECUTE FUNCTION "assessment_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "graph_extraction_items_no_truncate" BEFORE TRUNCATE ON "graph_extraction_items"
  FOR EACH STATEMENT EXECUTE FUNCTION "assessment_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "pre_interview_assessments_no_truncate" BEFORE TRUNCATE ON "pre_interview_assessments"
  FOR EACH STATEMENT EXECUTE FUNCTION "assessment_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "assessment_dimension_judgments_no_truncate" BEFORE TRUNCATE ON "assessment_dimension_judgments"
  FOR EACH STATEMENT EXECUTE FUNCTION "assessment_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "assessment_judgment_citations_no_truncate" BEFORE TRUNCATE ON "assessment_judgment_citations"
  FOR EACH STATEMENT EXECUTE FUNCTION "assessment_no_truncate"();
--> statement-breakpoint

-- 2. Assessment run state machine --------------------------------------------------------------------------------------------------
-- pending -> running | failed | cancelled; running -> running (heartbeat) | succeeded | failed | cancelled. Never backwards. The existing
-- analysis_runs_terminal_guard still freezes terminal rows. A run cannot become terminal while a call is still reserved: the in-flight
-- attempts must first be settled or reaped (they are then counted as unknown), so the budget the run ends with is complete.
CREATE FUNCTION "assessment_runs_transition_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.run_type <> 'pre_interview_assessment' THEN
    RETURN NEW;
  END IF;
  IF OLD.state = NEW.state THEN
    IF OLD.state = 'running' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a % assessment run cannot be updated', OLD.state USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT ((OLD.state = 'pending' AND NEW.state IN ('running', 'failed', 'cancelled'))
       OR (OLD.state = 'running' AND NEW.state IN ('succeeded', 'failed', 'cancelled'))) THEN
    RAISE EXCEPTION 'an assessment run cannot move from % to %', OLD.state, NEW.state USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.state = 'pending' AND NEW.state = 'running' THEN
    IF NOT EXISTS (SELECT 1 FROM "assessment_run_inputs" WHERE run_id = NEW.id)
       OR NOT EXISTS (SELECT 1 FROM "assessment_run_budget" WHERE run_id = NEW.id) THEN
      RAISE EXCEPTION 'an assessment run needs its pinned inputs and budget before it can run' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.state IN ('succeeded', 'failed', 'cancelled')
     AND EXISTS (SELECT 1 FROM "assessment_run_calls" WHERE run_id = NEW.id AND state = 'reserved') THEN
    RAISE EXCEPTION 'an assessment run cannot end while a model call is still reserved (reap it first)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assessment_runs_transition_guard" BEFORE UPDATE ON "analysis_runs"
  FOR EACH ROW EXECUTE FUNCTION "assessment_runs_transition_guard"();
--> statement-breakpoint

-- The end state of a run is complete only together with its outcome row, and a success only together with its assessment (deferred, so the
-- rows can be written in any order inside one transaction). A failed or cancelled run can never have an assessment.
CREATE FUNCTION "assessment_run_terminal_consistency"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_outcome "assessment_run_outcomes"%ROWTYPE;
  v_assessments integer;
BEGIN
  SELECT count(*) INTO v_assessments FROM "pre_interview_assessments" WHERE run_id = NEW.id;
  IF NEW.state IN ('pending', 'running') THEN
    IF NOT EXISTS (SELECT 1 FROM "assessment_run_inputs" WHERE run_id = NEW.id)
       OR NOT EXISTS (SELECT 1 FROM "assessment_run_budget" WHERE run_id = NEW.id) THEN
      RAISE EXCEPTION 'assessment run % lacks its pinned inputs or budget', NEW.id USING ERRCODE = 'check_violation';
    END IF;
    IF v_assessments > 0 OR EXISTS (SELECT 1 FROM "assessment_run_outcomes" WHERE run_id = NEW.id) THEN
      RAISE EXCEPTION 'an active assessment run cannot have an outcome or an assessment' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  SELECT * INTO v_outcome FROM "assessment_run_outcomes" WHERE run_id = NEW.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'terminal assessment run % has no outcome row', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF v_outcome.outcome <> NEW.state OR v_outcome.failure_category IS DISTINCT FROM NEW.failure_category THEN
    RAISE EXCEPTION 'the outcome row of run % disagrees with the run state', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = 'succeeded' AND v_assessments <> 1 THEN
    RAISE EXCEPTION 'a succeeded assessment run needs exactly one assessment' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> 'succeeded' AND v_assessments <> 0 THEN
    RAISE EXCEPTION 'a % assessment run can never have an assessment', NEW.state USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "assessment_run_terminal_consistency" AFTER INSERT OR UPDATE ON "analysis_runs"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.run_type = 'pre_interview_assessment')
  EXECUTE FUNCTION "assessment_run_terminal_consistency"();
--> statement-breakpoint

-- 3. Requests ---------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION "assessment_requests_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_type text;
BEGIN
  IF NEW.run_id IS NOT NULL THEN
    SELECT run_type INTO v_type FROM "analysis_runs" WHERE id = NEW.run_id;
    IF v_type IS DISTINCT FROM 'pre_interview_assessment' THEN
      RAISE EXCEPTION 'an assessment request can only reference an assessment run' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assessment_requests_guard" BEFORE INSERT ON "assessment_requests"
  FOR EACH ROW EXECUTE FUNCTION "assessment_requests_guard"();
--> statement-breakpoint

-- 4. Run pins ---------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION "assessment_run_inputs_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_run "analysis_runs"%ROWTYPE;
  v_version "event_context_versions"%ROWTYPE;
  v_key text;
  v_sel uuid;
BEGIN
  SELECT * INTO v_run FROM "analysis_runs" WHERE id = NEW.run_id;
  IF v_run.run_type IS DISTINCT FROM 'pre_interview_assessment' OR v_run.state <> 'pending' THEN
    RAISE EXCEPTION 'run inputs can only be pinned for a pending assessment run' USING ERRCODE = 'check_violation';
  END IF;
  IF v_run.context_version_id IS DISTINCT FROM NEW.context_version_id OR v_run.event_id IS DISTINCT FROM NEW.event_id THEN
    RAISE EXCEPTION 'the pinned context version must be the run''s' USING ERRCODE = 'check_violation';
  END IF;
  -- FOR SHARE serializes against a concurrent lock/supersede of the version (which updates this row).
  SELECT * INTO v_version FROM "event_context_versions" WHERE id = NEW.context_version_id FOR SHARE;
  IF v_version.status <> 'locked' OR v_version.locked_content_hash IS DISTINCT FROM NEW.locked_content_hash THEN
    RAISE EXCEPTION 'only the currently locked event context version, with its stored content hash, can be pinned' USING ERRCODE = 'check_violation';
  END IF;
  FOR v_key, v_sel IN SELECT k, s FROM unnest(NEW.declared_track_keys, NEW.track_selection_ids) AS t(k, s) LOOP
    IF NOT EXISTS (SELECT 1 FROM "project_track_selections" WHERE id = v_sel AND project_id = NEW.project_id AND track_key = v_key) THEN
      RAISE EXCEPTION 'declared track % is not a selection of this project', v_key USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "tracks" WHERE context_version_id = NEW.context_version_id AND key = v_key) THEN
      RAISE EXCEPTION 'declared track % does not exist in the pinned context version (TRACK_NOT_IN_PINNED_CONTEXT)', v_key USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF NEW.target_track_key IS NOT NULL AND NOT (NEW.target_track_key = ANY (NEW.declared_track_keys)) THEN
    RAISE EXCEPTION 'the scoring target track must be a declared track' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assessment_run_inputs_guard" BEFORE INSERT ON "assessment_run_inputs"
  FOR EACH ROW EXECUTE FUNCTION "assessment_run_inputs_guard"();
--> statement-breakpoint
CREATE FUNCTION "assessment_run_input_snapshots_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_snapshot "source_snapshots"%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "analysis_runs" WHERE id = NEW.run_id AND run_type = 'pre_interview_assessment' AND state = 'pending') THEN
    RAISE EXCEPTION 'snapshots can only be pinned for a pending assessment run' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_snapshot FROM "source_snapshots" WHERE id = NEW.snapshot_id AND project_id = NEW.project_id;
  IF NOT FOUND OR v_snapshot.status NOT IN ('captured', 'partial') OR v_snapshot.content_hash IS DISTINCT FROM NEW.snapshot_content_hash THEN
    RAISE EXCEPTION 'a pinned snapshot must be a captured or partial snapshot of the project, with its stored content hash' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assessment_run_input_snapshots_guard" BEFORE INSERT ON "assessment_run_input_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "assessment_run_input_snapshots_guard"();
--> statement-breakpoint
CREATE FUNCTION "assessment_run_budget_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "analysis_runs" WHERE id = NEW.run_id AND run_type = 'pre_interview_assessment' AND state = 'pending') THEN
    RAISE EXCEPTION 'a budget can only be created for a pending assessment run' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assessment_run_budget_guard" BEFORE INSERT ON "assessment_run_budget"
  FOR EACH ROW EXECUTE FUNCTION "assessment_run_budget_guard"();
--> statement-breakpoint

-- 5. Call ledger ---------------------------------------------------------------------------------------------------------------------
-- INSERT: the budget row is locked FOR UPDATE here too, so even direct SQL serializes per run; the denial order mirrors the
-- application guard (wall clock, per-call input, calls, input tokens, output tokens, cost). `seq` and `attempt` are assigned here.
-- The wall clock runs from the moment the run was CLAIMED (analysis_runs.started_at), not from when it was queued.
CREATE FUNCTION "assessment_run_calls_insert_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  b "assessment_run_budget"%ROWTYPE;
  v_state text;
  v_type text;
  v_started timestamptz;
  v_calls integer;
  v_max_seq integer;
  v_in numeric;
  v_out numeric;
  v_cost numeric;
  v_same integer;
BEGIN
  SELECT * INTO b FROM "assessment_run_budget" WHERE run_id = NEW.run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a model call needs the budget row of its run' USING ERRCODE = 'foreign_key_violation';
  END IF;
  SELECT state, run_type, started_at INTO v_state, v_type, v_started FROM "analysis_runs" WHERE id = NEW.run_id;
  IF v_type <> 'pre_interview_assessment' OR v_state <> 'running' THEN
    RAISE EXCEPTION 'model calls can only be recorded for a running assessment run (run is %)', v_state USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> 'reserved' THEN
    RAISE EXCEPTION 'a ledger row starts reserved' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*), coalesce(max(seq), 0),
         coalesce(sum(CASE state WHEN 'reserved' THEN reserved_input_tokens WHEN 'released' THEN 0 ELSE input_tokens END), 0),
         coalesce(sum(CASE state WHEN 'reserved' THEN reserved_output_tokens WHEN 'released' THEN 0 ELSE output_tokens END), 0),
         coalesce(sum(CASE state WHEN 'reserved' THEN reserved_cost_nano_usd WHEN 'released' THEN 0 ELSE cost_nano_usd END), 0),
         count(*) FILTER (WHERE request_digest = NEW.request_digest)
    INTO v_calls, v_max_seq, v_in, v_out, v_cost, v_same
    FROM "assessment_run_calls" WHERE run_id = NEW.run_id;
  IF (extract(epoch FROM (clock_timestamp() - v_started)) * 1000) >= b.run_wall_clock_ms THEN
    RAISE EXCEPTION 'assessment budget denied: wall_clock' USING ERRCODE = 'check_violation', HINT = 'wall_clock';
  END IF;
  IF NEW.reserved_input_tokens > b.max_reserved_input_tokens_per_call THEN
    RAISE EXCEPTION 'assessment budget denied: per_call_input' USING ERRCODE = 'check_violation', HINT = 'per_call_input';
  END IF;
  IF v_calls + 1 > b.max_calls THEN
    RAISE EXCEPTION 'assessment budget denied: calls' USING ERRCODE = 'check_violation', HINT = 'calls';
  END IF;
  IF v_in + NEW.reserved_input_tokens > b.max_input_tokens THEN
    RAISE EXCEPTION 'assessment budget denied: input_tokens' USING ERRCODE = 'check_violation', HINT = 'input_tokens';
  END IF;
  IF v_out + NEW.reserved_output_tokens > b.max_output_tokens THEN
    RAISE EXCEPTION 'assessment budget denied: output_tokens' USING ERRCODE = 'check_violation', HINT = 'output_tokens';
  END IF;
  IF v_cost + NEW.reserved_cost_nano_usd > b.max_cost_nano_usd THEN
    RAISE EXCEPTION 'assessment budget denied: cost' USING ERRCODE = 'check_violation', HINT = 'cost';
  END IF;
  NEW.seq := v_max_seq + 1;
  NEW.attempt := v_same + 1;
  NEW.reserved_at := clock_timestamp();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assessment_run_calls_insert_guard" BEFORE INSERT ON "assessment_run_calls"
  FOR EACH ROW EXECUTE FUNCTION "assessment_run_calls_insert_guard"();
--> statement-breakpoint
-- UPDATE: the single allowed transition reserved -> settled | released | unknown, with every identity and reservation column frozen.
CREATE FUNCTION "assessment_run_calls_update_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_frozen text[] := ARRAY['state', 'usage_basis', 'input_tokens', 'output_tokens', 'cost_nano_usd', 'outcome_code', 'response_hash',
                           'response_canonical', 'response_record', 'response_bytes', 'bound_violation', 'settled_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger rows are append-only and cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.state <> 'reserved' THEN
    RAISE EXCEPTION 'ledger row %/% is % and immutable', OLD.run_id, OLD.seq, OLD.state USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.state = 'reserved' THEN
    RAISE EXCEPTION 'a ledger row can only move out of reserved' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - v_frozen) IS DISTINCT FROM (to_jsonb(OLD) - v_frozen) THEN
    RAISE EXCEPTION 'a ledger row''s identity and reservation are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  NEW.settled_at := clock_timestamp();
  IF NEW.state = 'settled' THEN
    NEW.bound_violation := coalesce(NEW.input_tokens > OLD.reserved_input_tokens OR NEW.output_tokens > OLD.reserved_output_tokens, false);
  ELSE
    NEW.bound_violation := false;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assessment_run_calls_update_guard" BEFORE UPDATE OR DELETE ON "assessment_run_calls"
  FOR EACH ROW EXECUTE FUNCTION "assessment_run_calls_update_guard"();
--> statement-breakpoint

-- Terminal outcome: written after the run state, its totals are the ledger's (nothing may still be reserved).
CREATE FUNCTION "assessment_run_outcomes_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_run "analysis_runs"%ROWTYPE;
  v_attempts integer;
  v_settled integer;
  v_unknown integer;
  v_released integer;
  v_reserved integer;
  v_in numeric;
  v_out numeric;
  v_cost numeric;
BEGIN
  SELECT * INTO v_run FROM "analysis_runs" WHERE id = NEW.run_id;
  IF v_run.run_type IS DISTINCT FROM 'pre_interview_assessment' OR v_run.state <> NEW.outcome
     OR v_run.failure_category IS DISTINCT FROM NEW.failure_category THEN
    RAISE EXCEPTION 'an outcome must match the terminal state of its assessment run' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*), count(*) FILTER (WHERE state = 'settled'), count(*) FILTER (WHERE state = 'unknown'),
         count(*) FILTER (WHERE state = 'released'), count(*) FILTER (WHERE state = 'reserved'),
         coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0), coalesce(sum(cost_nano_usd), 0)
    INTO v_attempts, v_settled, v_unknown, v_released, v_reserved, v_in, v_out, v_cost
    FROM "assessment_run_calls" WHERE run_id = NEW.run_id;
  IF v_reserved > 0 THEN
    RAISE EXCEPTION 'a run cannot have an outcome while a call is still reserved' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempts_started <> v_attempts OR NEW.settled_calls <> v_settled OR NEW.unknown_calls <> v_unknown
     OR NEW.released_calls <> v_released OR NEW.input_tokens <> v_in OR NEW.output_tokens <> v_out OR NEW.cost_nano_usd <> v_cost THEN
    RAISE EXCEPTION 'the outcome totals must equal the ledger totals of the run' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assessment_run_outcomes_guard" BEFORE INSERT ON "assessment_run_outcomes"
  FOR EACH ROW EXECUTE FUNCTION "assessment_run_outcomes_guard"();
--> statement-breakpoint

-- 6. Graph extractions ------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION "graph_extractions_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_snapshot uuid;
BEGIN
  IF NEW.kind = 'context_evidence' THEN
    SELECT status INTO v_status FROM "event_context_versions" WHERE id = NEW.context_version_id;
    IF v_status IS NULL OR v_status NOT IN ('locked', 'superseded') THEN
      RAISE EXCEPTION 'a context extraction needs a locked or superseded event context version' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    FOREACH v_snapshot IN ARRAY NEW.snapshot_ids LOOP
      IF NOT EXISTS (SELECT 1 FROM "source_snapshots" WHERE id = v_snapshot AND project_id = NEW.project_id AND status IN ('captured', 'partial')) THEN
        RAISE EXCEPTION 'an extraction can only cite captured or partial snapshots of its project' USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
    IF (SELECT count(DISTINCT s) FROM unnest(NEW.snapshot_ids) AS t(s)) <> cardinality(NEW.snapshot_ids) THEN
      RAISE EXCEPTION 'snapshot ids must be unique' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.created_by_run_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "analysis_runs" WHERE id = NEW.created_by_run_id AND project_id = NEW.project_id
         AND run_type = 'pre_interview_assessment' AND state = 'running') THEN
    RAISE EXCEPTION 'an extraction can only be created by a running assessment run of its project' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "graph_extractions_guard" BEFORE INSERT ON "graph_extractions"
  FOR EACH ROW EXECUTE FUNCTION "graph_extractions_guard"();
--> statement-breakpoint
CREATE FUNCTION "graph_extraction_items_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_found boolean;
BEGIN
  v_found := CASE NEW.record_type
    WHEN 'claim' THEN EXISTS (SELECT 1 FROM "claims" WHERE id = NEW.record_id AND project_id = NEW.project_id)
    WHEN 'evidence' THEN EXISTS (SELECT 1 FROM "evidence_items" WHERE id = NEW.record_id AND project_id = NEW.project_id)
    WHEN 'relation' THEN EXISTS (SELECT 1 FROM "evidence_relations" WHERE id = NEW.record_id AND project_id = NEW.project_id)
    WHEN 'unknown' THEN EXISTS (SELECT 1 FROM "unknowns" WHERE id = NEW.record_id AND project_id = NEW.project_id)
    WHEN 'contradiction' THEN EXISTS (SELECT 1 FROM "contradictions" WHERE id = NEW.record_id AND project_id = NEW.project_id)
    ELSE false
  END;
  IF NOT v_found THEN
    RAISE EXCEPTION 'extraction member % % does not exist in project %', NEW.record_type, NEW.record_id, NEW.project_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.role = 'event_reference' AND NOT EXISTS (
       SELECT 1 FROM "evidence_items" WHERE id = NEW.record_id AND origin = 'event_context') THEN
    RAISE EXCEPTION 'only event_context evidence can be an event reference' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.role IN ('statement', 'interpreted_fact') AND EXISTS (
       SELECT 1 FROM "evidence_items" WHERE id = NEW.record_id AND origin = 'event_context') THEN
    RAISE EXCEPTION 'event_context evidence must be an event reference' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "graph_extraction_items_guard" BEFORE INSERT ON "graph_extraction_items"
  FOR EACH ROW EXECUTE FUNCTION "graph_extraction_items_guard"();
--> statement-breakpoint

-- Completeness, checked at COMMIT (after the graph rows and every item exist). Membership is the item rows; this verifies that they are
-- exactly what the extraction claims to be:
--   * counts and contiguous 1-based ordinals per type, equal to the extraction's counts;
--   * every member was created by THIS transaction (xmin = the current top-level xid) -- a record of an earlier writer cannot be claimed;
--   * no graph row this transaction created for the project is missing from the extractions (no half-listed graph);
--   * members_hash equals the SHA-256 of the canonical JSON of the sorted ids, recomputed here exactly as the application does;
--   * the member set is closed (relation endpoints, contradiction sides, unknown references) and has no supersession edge;
--   * a source extraction cites only its snapshots and no Event Context; a context extraction holds only that version's evidence.
-- xmin feasibility (P4 exit criterion, see M5-P4-note.md): xmin of a row inserted in a SAVEPOINT is the subtransaction id, which differs
-- from the top-level id, so the check FAILS CLOSED (rejects) inside a savepoint. The graph writer therefore never uses savepoints.
CREATE FUNCTION "graph_extraction_members_hash"(p_extraction uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(
    '{"claims":[' || coalesce((SELECT string_agg('"' || record_id::text || '"', ',' ORDER BY record_id::text COLLATE "C") FROM "graph_extraction_items" WHERE extraction_id = p_extraction AND record_type = 'claim'), '')
    || '],"contradictions":[' || coalesce((SELECT string_agg('"' || record_id::text || '"', ',' ORDER BY record_id::text COLLATE "C") FROM "graph_extraction_items" WHERE extraction_id = p_extraction AND record_type = 'contradiction'), '')
    || '],"evidence":[' || coalesce((SELECT string_agg('"' || record_id::text || '"', ',' ORDER BY record_id::text COLLATE "C") FROM "graph_extraction_items" WHERE extraction_id = p_extraction AND record_type = 'evidence'), '')
    || '],"relations":[' || coalesce((SELECT string_agg('"' || record_id::text || '"', ',' ORDER BY record_id::text COLLATE "C") FROM "graph_extraction_items" WHERE extraction_id = p_extraction AND record_type = 'relation'), '')
    || '],"unknowns":[' || coalesce((SELECT string_agg('"' || record_id::text || '"', ',' ORDER BY record_id::text COLLATE "C") FROM "graph_extraction_items" WHERE extraction_id = p_extraction AND record_type = 'unknown'), '')
    || ']}', 'UTF8')), 'hex')
$$;
--> statement-breakpoint
CREATE FUNCTION "graph_extractions_completeness"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_xid text := pg_current_xact_id()::xid::text;
  v_type text;
  v_expected integer;
  v_count integer;
  v_min integer;
  v_max integer;
  v_created integer;
BEGIN
  FOREACH v_type IN ARRAY ARRAY['claim', 'evidence', 'relation', 'unknown', 'contradiction'] LOOP
    v_expected := CASE v_type WHEN 'claim' THEN NEW.claim_count WHEN 'evidence' THEN NEW.evidence_count WHEN 'relation' THEN NEW.relation_count
                  WHEN 'unknown' THEN NEW.unknown_count ELSE NEW.contradiction_count END;
    SELECT count(*), coalesce(min(ordinal), 1), coalesce(max(ordinal), 0) INTO v_count, v_min, v_max
      FROM "graph_extraction_items" WHERE extraction_id = NEW.id AND record_type = v_type;
    IF v_count <> v_expected OR (v_count > 0 AND (v_min <> 1 OR v_max <> v_count)) THEN
      RAISE EXCEPTION 'extraction % lists % % members (declared %) or their ordinals are not 1..n', NEW.id, v_count, v_type, v_expected USING ERRCODE = 'check_violation';
    END IF;
    v_created := CASE v_type
      WHEN 'claim' THEN (SELECT count(*) FROM "graph_extraction_items" i JOIN "claims" c ON c.id = i.record_id WHERE i.extraction_id = NEW.id AND i.record_type = 'claim' AND c.project_id = NEW.project_id AND c.xmin::text = v_xid)
      WHEN 'evidence' THEN (SELECT count(*) FROM "graph_extraction_items" i JOIN "evidence_items" c ON c.id = i.record_id WHERE i.extraction_id = NEW.id AND i.record_type = 'evidence' AND c.project_id = NEW.project_id AND c.xmin::text = v_xid)
      WHEN 'relation' THEN (SELECT count(*) FROM "graph_extraction_items" i JOIN "evidence_relations" c ON c.id = i.record_id WHERE i.extraction_id = NEW.id AND i.record_type = 'relation' AND c.project_id = NEW.project_id AND c.xmin::text = v_xid)
      WHEN 'unknown' THEN (SELECT count(*) FROM "graph_extraction_items" i JOIN "unknowns" c ON c.id = i.record_id WHERE i.extraction_id = NEW.id AND i.record_type = 'unknown' AND c.project_id = NEW.project_id AND c.xmin::text = v_xid)
      ELSE (SELECT count(*) FROM "graph_extraction_items" i JOIN "contradictions" c ON c.id = i.record_id WHERE i.extraction_id = NEW.id AND i.record_type = 'contradiction' AND c.project_id = NEW.project_id AND c.xmin::text = v_xid)
    END;
    IF v_created <> v_count THEN
      RAISE EXCEPTION 'extraction % claims % % member(s) that this transaction did not create', NEW.id, v_count - v_created, v_type USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM "claims" c WHERE c.project_id = NEW.project_id AND c.xmin::text = v_xid
               AND NOT EXISTS (SELECT 1 FROM "graph_extraction_items" i WHERE i.record_type = 'claim' AND i.record_id = c.id))
     OR EXISTS (SELECT 1 FROM "evidence_items" c WHERE c.project_id = NEW.project_id AND c.xmin::text = v_xid
               AND NOT EXISTS (SELECT 1 FROM "graph_extraction_items" i WHERE i.record_type = 'evidence' AND i.record_id = c.id))
     OR EXISTS (SELECT 1 FROM "evidence_relations" c WHERE c.project_id = NEW.project_id AND c.xmin::text = v_xid
               AND NOT EXISTS (SELECT 1 FROM "graph_extraction_items" i WHERE i.record_type = 'relation' AND i.record_id = c.id))
     OR EXISTS (SELECT 1 FROM "unknowns" c WHERE c.project_id = NEW.project_id AND c.xmin::text = v_xid
               AND NOT EXISTS (SELECT 1 FROM "graph_extraction_items" i WHERE i.record_type = 'unknown' AND i.record_id = c.id))
     OR EXISTS (SELECT 1 FROM "contradictions" c WHERE c.project_id = NEW.project_id AND c.xmin::text = v_xid
               AND NOT EXISTS (SELECT 1 FROM "graph_extraction_items" i WHERE i.record_type = 'contradiction' AND i.record_id = c.id)) THEN
    RAISE EXCEPTION 'this transaction created graph records of project % that no extraction lists', NEW.project_id USING ERRCODE = 'check_violation';
  END IF;

  IF "graph_extraction_members_hash"(NEW.id) <> NEW.members_hash THEN
    RAISE EXCEPTION 'extraction % members_hash does not match its members', NEW.id USING ERRCODE = 'check_violation';
  END IF;

  -- closure
  IF EXISTS (
       SELECT 1 FROM "graph_extraction_items" i JOIN "evidence_relations" r ON r.id = i.record_id
        WHERE i.extraction_id = NEW.id AND i.record_type = 'relation'
          AND (NOT EXISTS (SELECT 1 FROM "graph_extraction_items" m WHERE m.extraction_id = NEW.id AND m.record_type = 'claim' AND m.record_id = r.claim_id)
            OR NOT EXISTS (SELECT 1 FROM "graph_extraction_items" m WHERE m.extraction_id = NEW.id AND m.record_type = 'evidence' AND m.record_id = r.evidence_id))) THEN
    RAISE EXCEPTION 'extraction % has a relation whose endpoint is not a member', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
       SELECT 1 FROM "graph_extraction_items" i JOIN "contradictions" c ON c.id = i.record_id
        WHERE i.extraction_id = NEW.id AND i.record_type = 'contradiction'
          AND ((c.side_a_claim_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "graph_extraction_items" m WHERE m.extraction_id = NEW.id AND m.record_type = 'claim' AND m.record_id = c.side_a_claim_id))
            OR (c.side_a_evidence_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "graph_extraction_items" m WHERE m.extraction_id = NEW.id AND m.record_type = 'evidence' AND m.record_id = c.side_a_evidence_id))
            OR (c.side_b_claim_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "graph_extraction_items" m WHERE m.extraction_id = NEW.id AND m.record_type = 'claim' AND m.record_id = c.side_b_claim_id))
            OR (c.side_b_evidence_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "graph_extraction_items" m WHERE m.extraction_id = NEW.id AND m.record_type = 'evidence' AND m.record_id = c.side_b_evidence_id)))) THEN
    RAISE EXCEPTION 'extraction % has a contradiction whose side is not a member', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
       SELECT 1 FROM "graph_extraction_items" i JOIN "unknowns" u ON u.id = i.record_id
        WHERE i.extraction_id = NEW.id AND i.record_type = 'unknown'
          AND (EXISTS (SELECT 1 FROM unnest(u.claim_ids) AS x(id) WHERE NOT EXISTS (SELECT 1 FROM "graph_extraction_items" m WHERE m.extraction_id = NEW.id AND m.record_type = 'claim' AND m.record_id = x.id))
            OR EXISTS (SELECT 1 FROM unnest(u.evidence_ids) AS x(id) WHERE NOT EXISTS (SELECT 1 FROM "graph_extraction_items" m WHERE m.extraction_id = NEW.id AND m.record_type = 'evidence' AND m.record_id = x.id)))) THEN
    RAISE EXCEPTION 'extraction % has an unknown whose reference is not a member', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "graph_extraction_items" i JOIN "claims" c ON c.id = i.record_id
              WHERE i.extraction_id = NEW.id AND i.record_type = 'claim' AND c.supersedes_id IS NOT NULL) THEN
    RAISE EXCEPTION 'an extraction cannot contain a supersession edge' USING ERRCODE = 'check_violation';
  END IF;

  -- kind shape
  IF NEW.kind = 'source' THEN
    IF EXISTS (SELECT 1 FROM "graph_extraction_items" i JOIN "evidence_items" e ON e.id = i.record_id
                WHERE i.extraction_id = NEW.id AND i.record_type = 'evidence'
                  AND (e.origin = 'event_context' OR e.snapshot_id IS NULL OR NOT (e.snapshot_id = ANY (NEW.snapshot_ids)))) THEN
      RAISE EXCEPTION 'a source extraction cites only its own snapshots' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.claim_count + NEW.relation_count + NEW.unknown_count + NEW.contradiction_count <> 0
       OR EXISTS (SELECT 1 FROM "graph_extraction_items" i JOIN "evidence_items" e ON e.id = i.record_id
                   WHERE i.extraction_id = NEW.id AND i.record_type = 'evidence'
                     AND (e.origin <> 'event_context' OR e.context_version_id IS DISTINCT FROM NEW.context_version_id)) THEN
      RAISE EXCEPTION 'a context extraction holds only reference evidence of its version' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "graph_extractions_completeness" AFTER INSERT ON "graph_extractions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "graph_extractions_completeness"();
--> statement-breakpoint

-- Run -> extraction binding.
CREATE FUNCTION "assessment_run_extractions_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_extraction "graph_extractions"%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "analysis_runs" WHERE id = NEW.run_id AND run_type = 'pre_interview_assessment' AND state = 'running') THEN
    RAISE EXCEPTION 'extractions can only be bound to a running assessment run' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_extraction FROM "graph_extractions" WHERE id = NEW.extraction_id AND project_id = NEW.project_id;
  IF NOT FOUND OR v_extraction.kind <> NEW.kind THEN
    RAISE EXCEPTION 'the bound extraction must be of the stated kind and of the run''s project' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'context_evidence' THEN
    IF v_extraction.context_version_id IS DISTINCT FROM (SELECT context_version_id FROM "assessment_run_inputs" WHERE run_id = NEW.run_id) THEN
      RAISE EXCEPTION 'the context extraction must be of the pinned context version' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM unnest(v_extraction.snapshot_ids) AS s(id)
                WHERE NOT EXISTS (SELECT 1 FROM "assessment_run_input_snapshots" p WHERE p.run_id = NEW.run_id AND p.snapshot_id = s.id)) THEN
      RAISE EXCEPTION 'a source extraction can only cite snapshots the run pinned' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assessment_run_extractions_guard" BEFORE INSERT ON "assessment_run_extractions"
  FOR EACH ROW EXECUTE FUNCTION "assessment_run_extractions_guard"();
--> statement-breakpoint

-- 7. The assessment ---------------------------------------------------------------------------------------------------------------------
-- BEFORE INSERT: serialize on the project, assign the gapless version number, and tie the row to exactly what the run pinned and bound.
CREATE FUNCTION "pre_interview_assessments_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_run "analysis_runs"%ROWTYPE;
  v_inputs "assessment_run_inputs"%ROWTYPE;
  v_status text;
  v_source uuid;
  v_context uuid;
  v_pins uuid[];
  v_extraction_snapshots uuid[];
BEGIN
  PERFORM 1 FROM "projects" WHERE id = NEW.project_id FOR NO KEY UPDATE;
  SELECT * INTO v_run FROM "analysis_runs" WHERE id = NEW.run_id;
  IF v_run.run_type IS DISTINCT FROM 'pre_interview_assessment' OR v_run.state <> 'running' OR v_run.project_id <> NEW.project_id THEN
    RAISE EXCEPTION 'an assessment can only be written by a running assessment run of its project' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_inputs FROM "assessment_run_inputs" WHERE run_id = NEW.run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the run has no pinned inputs' USING ERRCODE = 'check_violation';
  END IF;
  IF v_inputs.context_version_id <> NEW.context_version_id OR v_inputs.locked_content_hash <> NEW.locked_content_hash
     OR v_inputs.target_kind <> NEW.target_kind OR v_inputs.target_track_key IS DISTINCT FROM NEW.track_key
     OR v_inputs.pipeline_config_hash <> NEW.pipeline_config_hash THEN
    RAISE EXCEPTION 'the assessment disagrees with the inputs its run pinned' USING ERRCODE = 'check_violation';
  END IF;
  -- the pinned version must STILL be the event's locked version (a lock/supersede updates this row, which FOR SHARE waits for)
  SELECT status INTO v_status FROM "event_context_versions" WHERE id = NEW.context_version_id FOR SHARE;
  IF v_status IS DISTINCT FROM 'locked' THEN
    RAISE EXCEPTION 'the pinned event context version is no longer locked (context_superseded)' USING ERRCODE = 'check_violation';
  END IF;
  SELECT array_agg(snapshot_id ORDER BY snapshot_id) INTO v_pins FROM "assessment_run_input_snapshots" WHERE run_id = NEW.run_id;
  IF v_pins IS DISTINCT FROM (SELECT array_agg(s ORDER BY s) FROM unnest(NEW.pinned_snapshot_ids) AS t(s)) THEN
    RAISE EXCEPTION 'the assessment''s snapshot ids must equal the run''s pins' USING ERRCODE = 'check_violation';
  END IF;
  SELECT extraction_id INTO v_source FROM "assessment_run_extractions" WHERE run_id = NEW.run_id AND kind = 'source';
  SELECT extraction_id INTO v_context FROM "assessment_run_extractions" WHERE run_id = NEW.run_id AND kind = 'context_evidence';
  IF v_source IS DISTINCT FROM NEW.extraction_id OR v_context IS DISTINCT FROM NEW.context_extraction_id THEN
    RAISE EXCEPTION 'the assessment must use exactly the extractions its run bound' USING ERRCODE = 'check_violation';
  END IF;
  SELECT snapshot_ids INTO v_extraction_snapshots FROM "graph_extractions" WHERE id = NEW.extraction_id;
  IF EXISTS (SELECT 1 FROM unnest(v_extraction_snapshots) AS s(id) WHERE NOT (s.id = ANY (NEW.pinned_snapshot_ids))) THEN
    RAISE EXCEPTION 'the extraction cites a snapshot the run did not pin' USING ERRCODE = 'check_violation';
  END IF;
  -- storage integrity the database CAN verify; the M4 canonical hash of the body is verified by the application (verifyStoredAssessment)
  IF encode(sha256(convert_to(NEW.report_canonical, 'UTF8')), 'hex') <> NEW.report_text_sha256 THEN
    RAISE EXCEPTION 'report_text_sha256 is not the SHA-256 of report_canonical' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.report_canonical::jsonb IS DISTINCT FROM NEW.report THEN
    RAISE EXCEPTION 'the jsonb report is not the parsed report_canonical' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.report ->> 'outputHash' IS DISTINCT FROM NEW.output_hash OR NEW.report ->> 'engineVersion' IS DISTINCT FROM NEW.engine_version
     OR NEW.report ->> 'parametersHash' IS DISTINCT FROM NEW.parameters_hash OR NEW.report ->> 'inputFingerprint' IS DISTINCT FROM NEW.input_fingerprint
     OR NEW.report ->> 'graphFingerprint' IS DISTINCT FROM NEW.graph_fingerprint OR NEW.report -> 'rubric' ->> 'fingerprint' IS DISTINCT FROM NEW.rubric_fingerprint
     OR NEW.report -> 'rubric' ->> 'source' IS DISTINCT FROM NEW.rubric_source THEN
    RAISE EXCEPTION 'the assessment identity columns must equal the report they summarize' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(max(version_number), 0) + 1 INTO NEW.version_number FROM "pre_interview_assessments" WHERE project_id = NEW.project_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "pre_interview_assessments_guard" BEFORE INSERT ON "pre_interview_assessments"
  FOR EACH ROW EXECUTE FUNCTION "pre_interview_assessments_guard"();
--> statement-breakpoint

-- Judgments: the ledger calls they cite exist, belong to the run, and are of the right stage.
CREATE FUNCTION "assessment_dimension_judgments_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_run uuid;
  v_seq integer;
BEGIN
  SELECT run_id INTO v_run FROM "pre_interview_assessments" WHERE id = NEW.assessment_id;
  FOREACH v_seq IN ARRAY NEW.assessor_call_seqs LOOP
    IF NOT EXISTS (SELECT 1 FROM "assessment_run_calls" WHERE run_id = v_run AND seq = v_seq AND stage = 'dimension_assessment' AND state IN ('settled', 'unknown')) THEN
      RAISE EXCEPTION 'assessor call % is not a dimension_assessment call of the run', v_seq USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  FOREACH v_seq IN ARRAY NEW.critic_call_seqs LOOP
    IF NOT EXISTS (SELECT 1 FROM "assessment_run_calls" WHERE run_id = v_run AND seq = v_seq AND stage = 'critic' AND state IN ('settled', 'unknown')) THEN
      RAISE EXCEPTION 'critic call % is not a critic call of the run', v_seq USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assessment_dimension_judgments_guard" BEFORE INSERT ON "assessment_dimension_judgments"
  FOR EACH ROW EXECUTE FUNCTION "assessment_dimension_judgments_guard"();
--> statement-breakpoint

-- Citations: the cited evidence must be a member of the assessment's own extractions (the Event-Context reference set included), and a
-- reference citation must carry exactly the code-authored metadata of the member it cites, for a track the run declared.
CREATE FUNCTION "assessment_judgment_citations_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_assessment "pre_interview_assessments"%ROWTYPE;
  v_item "graph_extraction_items"%ROWTYPE;
  v_declared text[];
BEGIN
  SELECT * INTO v_assessment FROM "pre_interview_assessments" WHERE id = NEW.assessment_id;
  SELECT * INTO v_item FROM "graph_extraction_items"
    WHERE record_type = 'evidence' AND record_id = NEW.evidence_id
      AND extraction_id IN (v_assessment.extraction_id, v_assessment.context_extraction_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a citation must name evidence of the assessment''s own extractions' USING ERRCODE = 'check_violation';
  END IF;
  IF v_item.reference_applicability IS DISTINCT FROM NEW.reference_applicability
     OR v_item.reference_track_key IS DISTINCT FROM NEW.reference_track_key THEN
    RAISE EXCEPTION 'a citation''s reference metadata must equal the member''s code-authored metadata' USING ERRCODE = 'check_violation';
  END IF;
  IF v_item.reference_track_key IS NOT NULL THEN
    SELECT declared_track_keys INTO v_declared FROM "assessment_run_inputs" WHERE run_id = v_assessment.run_id;
    IF NOT (v_item.reference_track_key = ANY (v_declared)) THEN
      RAISE EXCEPTION 'a cited reference concerns a track the run did not declare' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assessment_judgment_citations_guard" BEFORE INSERT ON "assessment_judgment_citations"
  FOR EACH ROW EXECUTE FUNCTION "assessment_judgment_citations_guard"();
--> statement-breakpoint

-- Completeness of a written assessment, checked at COMMIT: the run ended `succeeded` in the same transaction, and the judgments are exactly
-- the dimensions of the report.
CREATE FUNCTION "pre_interview_assessments_completeness"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_state text;
  v_report_dimensions text[];
  v_judged text[];
BEGIN
  SELECT state INTO v_state FROM "analysis_runs" WHERE id = NEW.run_id;
  IF v_state IS DISTINCT FROM 'succeeded' THEN
    RAISE EXCEPTION 'an assessment exists only for a succeeded run (run is %)', v_state USING ERRCODE = 'check_violation';
  END IF;
  SELECT array_agg(d ->> 'id' ORDER BY d ->> 'id') INTO v_report_dimensions FROM jsonb_array_elements(NEW.report -> 'dimensions') AS t(d);
  SELECT array_agg(dimension_id ORDER BY dimension_id) INTO v_judged FROM "assessment_dimension_judgments" WHERE assessment_id = NEW.id;
  IF v_report_dimensions IS DISTINCT FROM v_judged THEN
    RAISE EXCEPTION 'the judgments of assessment % must be exactly the dimensions of its report', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "pre_interview_assessments_completeness" AFTER INSERT ON "pre_interview_assessments"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "pre_interview_assessments_completeness"();
