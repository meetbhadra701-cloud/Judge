-- M5 P4 R4 repair: integrity triggers and checks (additive; migrations 0010/0011 are not edited, their functions are REPLACED here).
--
-- Lock order, identical in every function below and in the application (documented in docs/milestones/M5-P4-R4-remediation.md):
--   project (FOR NO KEY UPDATE) -> pinned event_context_versions row (FOR SHARE) -> analysis_runs row (FOR UPDATE, or FOR SHARE for a
--   writer that must only keep the run from ending) -> assessment_run_budget row (FOR UPDATE) -> assessment_run_calls rows.
-- A row lock taken by an UPDATE (including the implicit one of a BEFORE UPDATE trigger) conflicts with FOR SHARE, so a ledger insert and a
-- terminal run update serialize on the run row whichever of them gets there first.

-- 1. Structural allow-lists for ledger metadata (F9) -------------------------------------------------------------------------------
-- The closed set is exactly the shape of `RenderedPrompt.closedSet`: five handle lists and one unit. Handles are short code-assigned tokens
-- (C-001, E-001, X-001, ...), never text. This is a structural allow-list and data minimization, not a secret scanner.
CREATE FUNCTION "assessment_closed_set_ok"(cs jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT cs IS NULL OR (
    jsonb_typeof(cs) = 'object'
    AND (SELECT count(*) FROM jsonb_object_keys(cs)) = 6
    AND jsonb_exists_all(cs, ARRAY['passages', 'claims', 'evidence', 'pairs', 'items', 'unit'])
    AND jsonb_typeof(cs -> 'passages') = 'array' AND jsonb_array_length(cs -> 'passages') <= 4096
    AND jsonb_typeof(cs -> 'claims') = 'array' AND jsonb_array_length(cs -> 'claims') <= 4096
    AND jsonb_typeof(cs -> 'evidence') = 'array' AND jsonb_array_length(cs -> 'evidence') <= 4096
    AND jsonb_typeof(cs -> 'pairs') = 'array' AND jsonb_array_length(cs -> 'pairs') <= 4096
    AND jsonb_typeof(cs -> 'items') = 'array' AND jsonb_array_length(cs -> 'items') <= 4096
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(cs) AS f(name, v), jsonb_array_elements(CASE WHEN jsonb_typeof(v) = 'array' THEN v ELSE '[]'::jsonb END) AS e(h)
       WHERE f.name <> 'unit' AND (jsonb_typeof(e.h) <> 'string' OR (e.h #>> '{}') !~ '^[A-Z]-[0-9]{3,6}$'))
    AND (jsonb_typeof(cs -> 'unit') = 'null'
         OR (jsonb_typeof(cs -> 'unit') = 'string' AND length(cs ->> 'unit') <= 128 AND (cs ->> 'unit') ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'))
  )
$$;
--> statement-breakpoint
-- The persisted generation settings are exactly the fields of `GenerationSettings` (packages/llm): nothing else is stored.
CREATE FUNCTION "assessment_generation_settings_ok"(s jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT s IS NULL OR (
    jsonb_typeof(s) = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(s) AS f(name, v)
       WHERE f.name NOT IN ('effort', 'maxOutputTokens', 'timeoutMs')
          OR (f.name = 'effort' AND (jsonb_typeof(f.v) <> 'string' OR (f.v #>> '{}') NOT IN ('low', 'medium', 'high')))
          OR (f.name IN ('maxOutputTokens', 'timeoutMs')
              AND (jsonb_typeof(f.v) <> 'number' OR (f.v #>> '{}') !~ '^[1-9][0-9]{0,8}$')))
  )
$$;
--> statement-breakpoint
-- NOT VALID: rows written before this migration are not re-validated (none exist outside development databases); every new or updated row is.
ALTER TABLE "assessment_run_calls" ADD CONSTRAINT "assessment_run_calls_closed_set_allowlist" CHECK ("assessment_closed_set_ok"(closed_set)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "assessment_run_calls" ADD CONSTRAINT "assessment_run_calls_settings_allowlist" CHECK ("assessment_generation_settings_ok"(generation_settings)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "assessment_run_calls" ADD CONSTRAINT "assessment_run_calls_dimension_stage" CHECK (dimension_id IS NULL OR stage IN ('dimension_assessment', 'critic')) NOT VALID;
--> statement-breakpoint

-- 2. Run state machine: take the budget lock before looking at the ledger (F3) ----------------------------------------------------------
CREATE OR REPLACE FUNCTION "assessment_runs_transition_guard"() RETURNS trigger
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
  IF NEW.state IN ('succeeded', 'failed', 'cancelled') THEN
    -- this row is locked by the UPDATE (so no ledger insert, which takes FOR SHARE on it, can interleave); the budget lock keeps the
    -- documented order run -> budget -> ledger rows, then the ledger is looked at
    PERFORM 1 FROM "assessment_run_budget" WHERE run_id = NEW.id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM "assessment_run_calls" WHERE run_id = NEW.id AND state = 'reserved') THEN
      RAISE EXCEPTION 'an assessment run cannot end while a model call is still reserved (reap it first)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- 3. Ledger insert: run row first (FOR SHARE), then the budget row, then the ledger; metadata and binding allow-lists (F3, F7, F9) ----------
CREATE OR REPLACE FUNCTION "assessment_run_calls_insert_guard"() RETURNS trigger
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
  v_binding jsonb;
BEGIN
  -- 1. the run row: a concurrent terminalization holds (or will take) a conflicting lock on it, so the state read here is the state at
  --    which this insert is serialized against every run update. FOR SHARE re-reads the latest committed version after waiting.
  SELECT state, run_type, started_at INTO v_state, v_type, v_started FROM "analysis_runs" WHERE id = NEW.run_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a model call needs its run' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_type <> 'pre_interview_assessment' OR v_state <> 'running' THEN
    RAISE EXCEPTION 'model calls can only be recorded for a running assessment run (run is %)', v_state USING ERRCODE = 'check_violation';
  END IF;
  -- 2. the budget row
  SELECT * INTO b FROM "assessment_run_budget" WHERE run_id = NEW.run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a model call needs the budget row of its run' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.state <> 'reserved' THEN
    RAISE EXCEPTION 'a ledger row starts reserved' USING ERRCODE = 'check_violation';
  END IF;
  -- 3. the binding of the closed set to the exact request (F7/F9): its canonical text is hashed, and every field of it equals a column
  IF NEW.closed_set IS NOT NULL THEN
    IF NEW.binding_canonical IS NULL OR NEW.closed_set_hash IS NULL THEN
      RAISE EXCEPTION 'a closed set needs its canonical binding and hash' USING ERRCODE = 'check_violation';
    END IF;
    IF encode(sha256(convert_to(NEW.binding_canonical, 'UTF8')), 'hex') <> NEW.closed_set_hash THEN
      RAISE EXCEPTION 'closed_set_hash is not the SHA-256 of the canonical binding' USING ERRCODE = 'check_violation';
    END IF;
    BEGIN
      v_binding := NEW.binding_canonical::jsonb;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'the canonical binding is not JSON' USING ERRCODE = 'check_violation';
    END;
    IF jsonb_typeof(v_binding) <> 'object'
       OR coalesce(v_binding ->> 'stage', '') <> NEW.stage
       OR coalesce(v_binding ->> 'requestDigest', '') <> NEW.request_digest
       OR coalesce(v_binding ->> 'dimensionId', '') <> coalesce(NEW.dimension_id, '')
       OR coalesce(v_binding ->> 'model', '') <> NEW.model
       OR coalesce(v_binding ->> 'provider', '') <> coalesce(NEW.provider, '')
       OR coalesce(v_binding ->> 'providerMode', '') <> coalesce(NEW.provider_mode, '')
       OR coalesce(v_binding ->> 'promptId', '') <> coalesce(NEW.prompt_id, '')
       OR coalesce(v_binding ->> 'promptVersion', '') <> coalesce(NEW.prompt_version, '')
       OR coalesce(v_binding ->> 'promptTemplateHash', '') <> coalesce(NEW.prompt_template_hash, '')
       OR coalesce(v_binding ->> 'schemaId', '') <> coalesce(NEW.schema_id, '')
       OR coalesce(v_binding ->> 'schemaVersion', '') <> coalesce(NEW.schema_version, '')
       OR (v_binding -> 'closedSet') IS DISTINCT FROM NEW.closed_set THEN
      RAISE EXCEPTION 'the canonical binding disagrees with the call it binds (stage, digest, dimension, model, prompt, schema or closed set)' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.binding_canonical IS NOT NULL OR NEW.closed_set_hash IS NOT NULL THEN
    RAISE EXCEPTION 'a binding without a closed set' USING ERRCODE = 'check_violation';
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

-- 4. Run inputs: the frozen assessment identity (F5) -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "assessment_run_inputs_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_run "analysis_runs"%ROWTYPE;
  v_version "event_context_versions"%ROWTYPE;
  v_key text;
  v_sel uuid;
  v_identity jsonb;
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
  -- R4 F5: the intended assessment identity is frozen with the run. Its key is the SHA-256 of its canonical text, and the fields of that
  -- text that this row also carries must agree with it.
  IF NEW.assessment_key IS NULL OR NEW.assessment_identity_canonical IS NULL THEN
    RAISE EXCEPTION 'a run needs its frozen assessment identity' USING ERRCODE = 'check_violation';
  END IF;
  IF encode(sha256(convert_to(NEW.assessment_identity_canonical, 'UTF8')), 'hex') <> NEW.assessment_key THEN
    RAISE EXCEPTION 'assessment_key is not the SHA-256 of its canonical identity' USING ERRCODE = 'check_violation';
  END IF;
  BEGIN
    v_identity := NEW.assessment_identity_canonical::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'the canonical assessment identity is not JSON' USING ERRCODE = 'check_violation';
  END;
  IF jsonb_typeof(v_identity) <> 'object'
     OR coalesce(v_identity ->> 'projectId', '') <> NEW.project_id::text
     OR coalesce(v_identity ->> 'contextVersionId', '') <> NEW.context_version_id::text
     OR coalesce(v_identity ->> 'lockedContentHash', '') <> NEW.locked_content_hash
     OR coalesce(v_identity ->> 'trackSelectionSetHash', '') <> NEW.track_selection_set_hash
     OR coalesce(v_identity ->> 'pipelineConfigHash', '') <> NEW.pipeline_config_hash
     OR coalesce(v_identity ->> 'targetKind', '') <> NEW.target_kind
     OR coalesce(v_identity ->> 'targetTrackKey', '') <> coalesce(NEW.target_track_key, '')
     OR (v_identity -> 'declaredTrackKeys') IS DISTINCT FROM to_jsonb(NEW.declared_track_keys) THEN
    RAISE EXCEPTION 'the frozen assessment identity disagrees with the pinned inputs of the run' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- 5. Extractions: derived keys and recorded key-defining inputs (F6) ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "graph_extractions_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_hash text;
  v_snapshot uuid;
  v_identity jsonb;
  v_declared text;
BEGIN
  IF NEW.kind = 'context_evidence' THEN
    SELECT status, locked_content_hash INTO v_status, v_hash FROM "event_context_versions" WHERE id = NEW.context_version_id;
    IF v_status IS NULL OR v_status NOT IN ('locked', 'superseded') THEN
      RAISE EXCEPTION 'a context extraction needs a locked or superseded event context version' USING ERRCODE = 'check_violation';
    END IF;
    FOREACH v_declared IN ARRAY NEW.declared_track_keys LOOP
      IF NOT EXISTS (SELECT 1 FROM "tracks" WHERE context_version_id = NEW.context_version_id AND key = v_declared) THEN
        RAISE EXCEPTION 'declared track % is not defined by the context version of the extraction', v_declared USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
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
  -- R4 F6: the extraction key is the SHA-256 of the canonical text of its key-defining inputs, and the fields of that text equal the
  -- columns and the stored state of what they name (snapshot content hashes, the locked version hash).
  IF NEW.identity_canonical IS NULL OR NEW.content_fingerprint IS NULL THEN
    RAISE EXCEPTION 'an extraction needs its canonical identity and content fingerprint' USING ERRCODE = 'check_violation';
  END IF;
  IF encode(sha256(convert_to(NEW.identity_canonical, 'UTF8')), 'hex') <> NEW.extraction_key THEN
    RAISE EXCEPTION 'extraction_key is not the SHA-256 of its canonical identity' USING ERRCODE = 'check_violation';
  END IF;
  BEGIN
    v_identity := NEW.identity_canonical::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'the canonical extraction identity is not JSON' USING ERRCODE = 'check_violation';
  END;
  IF jsonb_typeof(v_identity) <> 'object'
     OR coalesce(v_identity ->> 'kind', '') <> NEW.kind
     OR coalesce(v_identity ->> 'projectId', '') <> NEW.project_id::text
     OR coalesce(v_identity ->> 'configHash', '') <> NEW.config_hash
     OR (v_identity -> 'declaredTrackKeys') IS DISTINCT FROM to_jsonb(NEW.declared_track_keys) THEN
    RAISE EXCEPTION 'the canonical extraction identity disagrees with the extraction' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'context_evidence' THEN
    IF coalesce(v_identity ->> 'contextVersionId', '') <> NEW.context_version_id::text
       OR coalesce(v_identity ->> 'lockedContentHash', '') IS DISTINCT FROM coalesce(v_hash, '') THEN
      RAISE EXCEPTION 'the canonical extraction identity names another context version or hash' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF coalesce((SELECT array_agg(e ->> 'snapshotId' ORDER BY e ->> 'snapshotId' COLLATE "C") FROM jsonb_array_elements(v_identity -> 'snapshots') AS t(e)), '{}'::text[])
         IS DISTINCT FROM coalesce((SELECT array_agg(s::text ORDER BY s::text COLLATE "C") FROM unnest(NEW.snapshot_ids) AS t(s)), '{}'::text[]) THEN
      RAISE EXCEPTION 'the canonical extraction identity names other snapshots than the extraction cites' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_identity -> 'snapshots') AS t(e)
           JOIN "source_snapshots" s ON s.id = (e ->> 'snapshotId')::uuid
          WHERE s.content_hash IS DISTINCT FROM (e ->> 'contentHash')) THEN
      RAISE EXCEPTION 'the canonical extraction identity records another snapshot content hash than the stored one' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- 6. Run -> extraction binding: exact coverage and no over-declaration (F6, F8) -------------------------------------------------------------
CREATE OR REPLACE FUNCTION "assessment_run_extractions_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_extraction "graph_extractions"%ROWTYPE;
  v_inputs "assessment_run_inputs"%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "analysis_runs" WHERE id = NEW.run_id AND run_type = 'pre_interview_assessment' AND state = 'running') THEN
    RAISE EXCEPTION 'extractions can only be bound to a running assessment run' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_extraction FROM "graph_extractions" WHERE id = NEW.extraction_id AND project_id = NEW.project_id;
  IF NOT FOUND OR v_extraction.kind <> NEW.kind THEN
    RAISE EXCEPTION 'the bound extraction must be of the stated kind and of the run''s project' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_inputs FROM "assessment_run_inputs" WHERE run_id = NEW.run_id;
  IF v_extraction.identity_canonical IS NULL THEN
    RAISE EXCEPTION 'an extraction without a recorded identity cannot be bound' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'context_evidence' THEN
    IF v_extraction.context_version_id IS DISTINCT FROM v_inputs.context_version_id THEN
      RAISE EXCEPTION 'the context extraction must be of the pinned context version' USING ERRCODE = 'check_violation';
    END IF;
    -- the reference set was built for exactly the tracks the run declares, and no member names another track
    IF NOT (v_extraction.declared_track_keys <@ v_inputs.declared_track_keys AND v_extraction.declared_track_keys @> v_inputs.declared_track_keys) THEN
      RAISE EXCEPTION 'the context extraction was built for other declared tracks than the run declares (over- or under-declared)' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "graph_extraction_items" i
                WHERE i.extraction_id = v_extraction.id AND i.reference_track_key IS NOT NULL
                  AND NOT (i.reference_track_key = ANY (v_inputs.declared_track_keys))) THEN
      RAISE EXCEPTION 'the context extraction refers to a track the run did not declare' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    -- exact coverage: the extraction cites every snapshot the run pinned and no other
    IF EXISTS (SELECT 1 FROM unnest(v_extraction.snapshot_ids) AS s(id)
                WHERE NOT EXISTS (SELECT 1 FROM "assessment_run_input_snapshots" p WHERE p.run_id = NEW.run_id AND p.snapshot_id = s.id)) THEN
      RAISE EXCEPTION 'a source extraction can only cite snapshots the run pinned' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "assessment_run_input_snapshots" p
                WHERE p.run_id = NEW.run_id AND NOT (p.snapshot_id = ANY (v_extraction.snapshot_ids))) THEN
      RAISE EXCEPTION 'a source extraction must cover every snapshot the run pinned' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- 7. The assessment: the frozen key, the report's context identity, fallback anchors stay off ---------------------------------------------
CREATE OR REPLACE FUNCTION "pre_interview_assessments_guard"() RETURNS trigger
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
  -- R4 F5: the key frozen when the run was requested; a caller cannot choose another one at persistence
  IF v_inputs.assessment_key IS NULL OR NEW.assessment_key <> v_inputs.assessment_key THEN
    RAISE EXCEPTION 'the assessment key must be the one frozen when the run was requested' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.fallback_anchors_version IS NOT NULL THEN
    RAISE EXCEPTION 'fallback anchors are not approved; fallback_anchors_version must be null' USING ERRCODE = 'check_violation';
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
  -- representation consistency (NOT a proof of the M4 calculation, which only the application's recomputation provides): a report that
  -- names a context version names the pinned one and its content hash
  IF (NEW.report -> 'rubric' ->> 'contextVersionId') IS NOT NULL
     AND ((NEW.report -> 'rubric' ->> 'contextVersionId') <> NEW.context_version_id::text
          OR (NEW.report -> 'rubric' ->> 'contextContentHash') IS DISTINCT FROM NEW.locked_content_hash) THEN
    RAISE EXCEPTION 'the report names another event context than the run pinned' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(max(version_number), 0) + 1 INTO NEW.version_number FROM "pre_interview_assessments" WHERE project_id = NEW.project_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- 8. Judgments: every cited call belongs to THIS run, THIS dimension and the right stage, and proves what the row claims (F7) -------------
CREATE OR REPLACE FUNCTION "assessment_dimension_judgments_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_run uuid;
  v_seq integer;
  v_call "assessment_run_calls"%ROWTYPE;
  v_last integer;
  v_valid_assessor constant text[] := ARRAY['scored', 'assessor_reported_insufficient', 'event_reference_only', 'no_project_derived_citation',
                                            'no_applicable_context_cited', 'no_declared_need_satisfied', 'marked_insufficient_by_critic', 'critic_unavailable'];
  v_pre_gated constant text[] := ARRAY['no_candidate_evidence', 'no_satisfiable_need', 'no_official_requirement_available', 'official_requirement_omitted_by_limit'];
BEGIN
  SELECT run_id INTO v_run FROM "pre_interview_assessments" WHERE id = NEW.assessment_id;
  IF NEW.assessor_attempts <> cardinality(NEW.assessor_call_seqs) OR NEW.critic_attempts <> cardinality(NEW.critic_call_seqs)
     OR (SELECT count(DISTINCT s) FROM unnest(NEW.assessor_call_seqs) AS t(s)) <> cardinality(NEW.assessor_call_seqs)
     OR (SELECT count(DISTINCT s) FROM unnest(NEW.critic_call_seqs) AS t(s)) <> cardinality(NEW.critic_call_seqs) THEN
    RAISE EXCEPTION 'the attempt counts must equal the distinct calls listed' USING ERRCODE = 'check_violation';
  END IF;
  FOREACH v_seq IN ARRAY NEW.assessor_call_seqs LOOP
    SELECT * INTO v_call FROM "assessment_run_calls" WHERE run_id = v_run AND seq = v_seq;
    IF NOT FOUND OR v_call.stage <> 'dimension_assessment' OR v_call.dimension_id IS DISTINCT FROM NEW.dimension_id OR v_call.state = 'reserved' THEN
      RAISE EXCEPTION 'assessor call % is not a finished dimension_assessment call of this run for dimension %', v_seq, NEW.dimension_id USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  FOREACH v_seq IN ARRAY NEW.critic_call_seqs LOOP
    SELECT * INTO v_call FROM "assessment_run_calls" WHERE run_id = v_run AND seq = v_seq;
    IF NOT FOUND OR v_call.stage <> 'critic' OR v_call.dimension_id IS DISTINCT FROM NEW.dimension_id OR v_call.state = 'reserved' THEN
      RAISE EXCEPTION 'critic call % is not a finished critic call of this run for dimension %', v_seq, NEW.dimension_id USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF NEW.disposition = ANY (v_pre_gated) AND (cardinality(NEW.assessor_call_seqs) > 0 OR cardinality(NEW.critic_call_seqs) > 0) THEN
    RAISE EXCEPTION 'a unit decided before any model call has no calls' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.disposition = ANY (v_valid_assessor) THEN
    SELECT max(s) INTO v_last FROM unnest(NEW.assessor_call_seqs) AS t(s);
    IF v_last IS NULL OR NOT EXISTS (SELECT 1 FROM "assessment_run_calls" WHERE run_id = v_run AND seq = v_last AND state = 'settled'
                                         AND response_record = 'stored' AND outcome_code = 'ok' AND NOT bound_violation) THEN
      RAISE EXCEPTION 'disposition % rests on a valid assessor response; the last assessor call is not one', NEW.disposition USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.disposition IN ('assessor_output_invalid', 'provider_refused') AND cardinality(NEW.assessor_call_seqs) = 0 THEN
    RAISE EXCEPTION 'disposition % needs at least one assessor attempt', NEW.disposition USING ERRCODE = 'check_violation';
  END IF;
  -- a completed critic review needs a VALID critic response for this dimension: an unknown, released or invalid attempt proves nothing
  IF NEW.critic_reviewed THEN
    SELECT max(s) INTO v_last FROM unnest(NEW.critic_call_seqs) AS t(s);
    IF v_last IS NULL OR NOT EXISTS (SELECT 1 FROM "assessment_run_calls" WHERE run_id = v_run AND seq = v_last AND state = 'settled'
                                         AND response_record = 'stored' AND outcome_code = 'ok' AND NOT bound_violation) THEN
      RAISE EXCEPTION 'a completed critic review needs a valid settled critic response for the dimension' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.disposition = 'marked_insufficient_by_critic' AND NOT NEW.critic_reviewed THEN
    RAISE EXCEPTION 'a substantive critic rejection needs a completed critic review' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.disposition = 'critic_unavailable' AND (NEW.critic_reviewed OR cardinality(NEW.critic_call_seqs) = 0) THEN
    RAISE EXCEPTION 'critic_unavailable means the critic was attempted and did not complete' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- 9. Completeness at COMMIT: judgments are the report's dimensions, and each agrees with its report dimension (F1 defense in depth) --------
-- This verifies the REPRESENTATION. It does not recompute the M4 score: only the application's re-run of the engine proves that.
CREATE OR REPLACE FUNCTION "pre_interview_assessments_completeness"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_state text;
  v_report_dimensions text[];
  v_judged text[];
  j "assessment_dimension_judgments"%ROWTYPE;
  v_dim jsonb;
  v_cited text[];
  v_reported text[];
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
  FOR j IN SELECT * FROM "assessment_dimension_judgments" WHERE assessment_id = NEW.id LOOP
    SELECT d INTO v_dim FROM jsonb_array_elements(NEW.report -> 'dimensions') AS t(d) WHERE d ->> 'id' = j.dimension_id;
    SELECT coalesce(array_agg(c.evidence_id::text ORDER BY c.evidence_id::text COLLATE "C"), '{}'::text[]) INTO v_cited
      FROM "assessment_judgment_citations" c WHERE c.assessment_id = NEW.id AND c.dimension_id = j.dimension_id;
    SELECT coalesce(array_agg(x ORDER BY x COLLATE "C"), '{}'::text[]) INTO v_reported FROM jsonb_array_elements_text(v_dim -> 'citedEvidenceIds') AS t(x);
    IF v_cited IS DISTINCT FROM v_reported THEN
      RAISE EXCEPTION 'the citations stored for % differ from the evidence the report says it cited', j.dimension_id USING ERRCODE = 'check_violation';
    END IF;
    IF j.outcome_kind = 'scored' THEN
      IF v_dim ->> 'state' = 'assessed' THEN
        IF j.score IS NULL OR abs((v_dim ->> 'scoreOnScale')::numeric - j.score::numeric) > 0.0001 THEN
          RAISE EXCEPTION 'the stored score of % differs from the score on the report', j.dimension_id USING ERRCODE = 'check_violation';
        END IF;
      ELSIF NOT (v_dim ->> 'state' = 'insufficient_evidence' AND v_dim ->> 'reason' = 'no_usable_citation') THEN
        RAISE EXCEPTION 'a scored judgment of % is neither assessed nor no_usable_citation on the report', j.dimension_id USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NOT (v_dim ->> 'state' = 'insufficient_evidence' AND v_dim ->> 'reason' = 'assessor_reported_insufficient') THEN
      RAISE EXCEPTION 'an insufficient judgment of % is not insufficient_evidence on the report', j.dimension_id USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
