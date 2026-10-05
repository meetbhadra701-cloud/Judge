-- M3: evidence graph integrity. Hand-written: drizzle-kit does not model triggers.
-- The evidence graph is historical evidence. Normal application paths (and direct SQL) cannot
-- rewrite or erase it; an administrator can still run an explicit, reviewed data migration by
-- disabling these triggers inside it.

-- 1. Append-only: no UPDATE, DELETE or TRUNCATE on any graph table ----------------------------
CREATE FUNCTION "evidence_graph_immutable_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable historical evidence; create a new record instead (a corrected claim supersedes the old one)', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "claims_immutable_guard" BEFORE UPDATE OR DELETE ON "claims"
  FOR EACH ROW EXECUTE FUNCTION "evidence_graph_immutable_guard"();
--> statement-breakpoint
CREATE TRIGGER "evidence_items_immutable_guard" BEFORE UPDATE OR DELETE ON "evidence_items"
  FOR EACH ROW EXECUTE FUNCTION "evidence_graph_immutable_guard"();
--> statement-breakpoint
CREATE TRIGGER "evidence_relations_immutable_guard" BEFORE UPDATE OR DELETE ON "evidence_relations"
  FOR EACH ROW EXECUTE FUNCTION "evidence_graph_immutable_guard"();
--> statement-breakpoint
CREATE TRIGGER "unknowns_immutable_guard" BEFORE UPDATE OR DELETE ON "unknowns"
  FOR EACH ROW EXECUTE FUNCTION "evidence_graph_immutable_guard"();
--> statement-breakpoint
CREATE TRIGGER "contradictions_immutable_guard" BEFORE UPDATE OR DELETE ON "contradictions"
  FOR EACH ROW EXECUTE FUNCTION "evidence_graph_immutable_guard"();
--> statement-breakpoint

CREATE FUNCTION "evidence_graph_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% cannot be truncated: the evidence graph is append-only', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "claims_no_truncate" BEFORE TRUNCATE ON "claims"
  FOR EACH STATEMENT EXECUTE FUNCTION "evidence_graph_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "evidence_items_no_truncate" BEFORE TRUNCATE ON "evidence_items"
  FOR EACH STATEMENT EXECUTE FUNCTION "evidence_graph_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "evidence_relations_no_truncate" BEFORE TRUNCATE ON "evidence_relations"
  FOR EACH STATEMENT EXECUTE FUNCTION "evidence_graph_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "unknowns_no_truncate" BEFORE TRUNCATE ON "unknowns"
  FOR EACH STATEMENT EXECUTE FUNCTION "evidence_graph_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "contradictions_no_truncate" BEFORE TRUNCATE ON "contradictions"
  FOR EACH STATEMENT EXECUTE FUNCTION "evidence_graph_no_truncate"();
--> statement-breakpoint

-- 2. Claims: verification never silently drops across a supersession ---------------------------
-- Same-project and single-successor identity are enforced by the composite foreign key and the
-- unique constraint on supersedes_id. The tier ladder is docs/SCORING.md section 8:
-- unverified < team_claim < repo_corroborated = machine_verified < judge_verified = live_verified;
-- 'contradicted' is off the ladder and may be entered or left freely. Mirrors
-- isVerificationTransitionAllowed in @judge-copilot/evidence (a test compares all 49 pairs).
CREATE FUNCTION "evidence_graph_verification_tier"(level text) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE level
    WHEN 'unverified' THEN 0
    WHEN 'team_claim' THEN 1
    WHEN 'repo_corroborated' THEN 2
    WHEN 'machine_verified' THEN 2
    WHEN 'judge_verified' THEN 3
    WHEN 'live_verified' THEN 3
    ELSE NULL
  END
$$;
--> statement-breakpoint
CREATE FUNCTION "claims_supersession_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_old text;
  v_old_tier integer;
  v_new_tier integer;
BEGIN
  IF NEW.supersedes_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT verification_level INTO v_old FROM "claims"
    WHERE id = NEW.supersedes_id AND project_id = NEW.project_id;
  IF NOT FOUND THEN
    -- The composite foreign key reports a missing or cross-project predecessor.
    RETURN NEW;
  END IF;
  v_old_tier := "evidence_graph_verification_tier"(v_old);
  v_new_tier := "evidence_graph_verification_tier"(NEW.verification_level);
  IF v_old_tier IS NOT NULL AND v_new_tier IS NOT NULL AND v_new_tier < v_old_tier THEN
    RAISE EXCEPTION 'a claim cannot move from % to % when superseded; verification never silently drops', v_old, NEW.verification_level
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "claims_supersession_guard" BEFORE INSERT ON "claims"
  FOR EACH ROW EXECUTE FUNCTION "claims_supersession_guard"();
--> statement-breakpoint

-- 3. Evidence provenance ------------------------------------------------------------------------
-- The composite foreign keys already pin the snapshot to the project, the artifact to that
-- snapshot, and the context version to the project's event. Rows referenced here never change
-- (snapshots are terminal-immutable, artifacts immutable, frozen context versions never revert),
-- so a plain read is race-free. A snapshot still pending at insert time is rejected.
CREATE FUNCTION "evidence_items_provenance_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_source_type text;
  v_chars integer;
  v_span text;
  v_version_status text;
BEGIN
  IF NEW.snapshot_id IS NOT NULL THEN
    SELECT status, source_type INTO v_status, v_source_type
      FROM "source_snapshots" WHERE id = NEW.snapshot_id;
    IF FOUND THEN
      IF v_status NOT IN ('captured', 'partial') THEN
        RAISE EXCEPTION 'evidence can only cite a captured or partial snapshot (snapshot is %)', v_status
          USING ERRCODE = 'check_violation';
      END IF;
      IF v_source_type IS DISTINCT FROM NEW.origin THEN
        RAISE EXCEPTION 'evidence with origin % cannot cite a % snapshot', NEW.origin, v_source_type
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  -- A malformed span (negative, empty or reversed) is reported by the span_shape CHECK.
  IF NEW.span_start IS NOT NULL AND NEW.span_start >= 0 AND NEW.span_end > NEW.span_start THEN
    SELECT char_length(text_content), substr(text_content, NEW.span_start + 1, NEW.span_end - NEW.span_start)
      INTO v_chars, v_span
      FROM "source_snapshot_artifacts" WHERE id = NEW.artifact_id AND snapshot_id = NEW.snapshot_id;
    IF FOUND THEN
      IF NEW.span_end > v_chars THEN
        RAISE EXCEPTION 'evidence span ends past the artifact text (% code points)', v_chars
          USING ERRCODE = 'check_violation';
      END IF;
      IF v_span IS DISTINCT FROM NEW.excerpt THEN
        RAISE EXCEPTION 'evidence excerpt is not the exact text of its span'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW.context_version_id IS NOT NULL THEN
    SELECT status INTO v_version_status
      FROM "event_context_versions" WHERE id = NEW.context_version_id;
    IF FOUND AND v_version_status NOT IN ('locked', 'superseded') THEN
      RAISE EXCEPTION 'evidence can only cite a locked or superseded event context version (version is %)', v_version_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "evidence_items_provenance_guard" BEFORE INSERT ON "evidence_items"
  FOR EACH ROW EXECUTE FUNCTION "evidence_items_provenance_guard"();
--> statement-breakpoint

-- 4. Relations: absence/unknown evidence cannot support or contradict (invariant 3) -----------
CREATE FUNCTION "evidence_relations_kind_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_kind text;
BEGIN
  SELECT kind INTO v_kind FROM "evidence_items" WHERE id = NEW.evidence_id;
  IF NOT FOUND THEN
    RETURN NEW; -- the composite foreign key reports it
  END IF;
  IF NEW.relation_type = 'supports' AND v_kind NOT IN ('fact', 'claim') THEN
    RAISE EXCEPTION '% evidence cannot support a claim (missing evidence is not negative evidence)', v_kind
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.relation_type = 'contradicts' AND v_kind NOT IN ('fact', 'claim', 'contradiction') THEN
    RAISE EXCEPTION '% evidence cannot contradict a claim (missing evidence is not negative evidence)', v_kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "evidence_relations_kind_guard" BEFORE INSERT ON "evidence_relations"
  FOR EACH ROW EXECUTE FUNCTION "evidence_relations_kind_guard"();
--> statement-breakpoint

-- 5. Unknowns: every referenced claim/evidence item exists in the same project ----------------
CREATE FUNCTION "unknowns_reference_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_found integer;
BEGIN
  IF array_position(NEW.claim_ids, NULL) IS NOT NULL OR array_position(NEW.evidence_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'an unknown cannot reference a null id' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(DISTINCT x) FROM unnest(NEW.claim_ids) AS u(x)) <> cardinality(NEW.claim_ids)
     OR (SELECT count(DISTINCT x) FROM unnest(NEW.evidence_ids) AS u(x)) <> cardinality(NEW.evidence_ids) THEN
    RAISE EXCEPTION 'an unknown cannot reference the same item twice' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO v_found FROM "claims" c
    WHERE c.project_id = NEW.project_id AND c.id = ANY (NEW.claim_ids);
  IF v_found <> cardinality(NEW.claim_ids) THEN
    RAISE EXCEPTION 'an unknown references a claim that does not exist in its project'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  SELECT count(*) INTO v_found FROM "evidence_items" e
    WHERE e.project_id = NEW.project_id AND e.id = ANY (NEW.evidence_ids);
  IF v_found <> cardinality(NEW.evidence_ids) THEN
    RAISE EXCEPTION 'an unknown references an evidence item that does not exist in its project'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "unknowns_reference_guard" BEFORE INSERT ON "unknowns"
  FOR EACH ROW EXECUTE FUNCTION "unknowns_reference_guard"();
--> statement-breakpoint

-- 6. Contradictions: absence/unknown evidence cannot be a side --------------------------------
CREATE FUNCTION "contradictions_kind_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_kind text;
  v_id uuid;
BEGIN
  FOREACH v_id IN ARRAY ARRAY[NEW.side_a_evidence_id, NEW.side_b_evidence_id] LOOP
    IF v_id IS NOT NULL THEN
      SELECT kind INTO v_kind FROM "evidence_items" WHERE id = v_id;
      IF FOUND AND v_kind NOT IN ('fact', 'claim', 'contradiction') THEN
        RAISE EXCEPTION '% evidence cannot be a side of a contradiction (missing evidence is not negative evidence)', v_kind
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "contradictions_kind_guard" BEFORE INSERT ON "contradictions"
  FOR EACH ROW EXECUTE FUNCTION "contradictions_kind_guard"();
