-- M2: project-source ingestion integrity. Hand-written: drizzle-kit does not model triggers.
-- Normal application paths (and direct SQL) cannot rewrite capture history; an administrator can
-- still perform an explicit, reviewed data migration by disabling these triggers inside it.

-- 1. Actors are immutable identities ------------------------------------------------------------
CREATE FUNCTION "actors_immutable_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'actors are immutable and are never deleted'
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "actors_immutable_guard" BEFORE UPDATE OR DELETE ON "actors"
  FOR EACH ROW EXECUTE FUNCTION "actors_immutable_guard"();
--> statement-breakpoint

-- 2. Projects belong to one event for life -----------------------------------------------------
CREATE FUNCTION "projects_identity_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'projects are never deleted through normal paths'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.event_id <> OLD.event_id OR NEW.created_at <> OLD.created_at
     OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id THEN
    RAISE EXCEPTION 'project identity (id, event, creation) is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "projects_identity_guard" BEFORE UPDATE OR DELETE ON "projects"
  FOR EACH ROW EXECUTE FUNCTION "projects_identity_guard"();
--> statement-breakpoint

-- 3. Track declarations: validated against the locked context, then immutable -----------------
-- The composite foreign keys already pin event, context version and track together. This adds
-- that the version is the event's locked one at declaration time and that the key matches.
CREATE FUNCTION "project_track_selections_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_key text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'track declarations are immutable; a later context version never rewrites them'
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT status INTO v_status FROM "event_context_versions" WHERE id = NEW.context_version_id FOR SHARE;
  IF v_status IS DISTINCT FROM 'locked' THEN
    RAISE EXCEPTION 'tracks can only be declared against the locked event context'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT key INTO v_key FROM "tracks" WHERE id = NEW.track_id AND context_version_id = NEW.context_version_id;
  IF v_key IS DISTINCT FROM NEW.track_key THEN
    RAISE EXCEPTION 'track key does not match the declared track'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "project_track_selections_guard" BEFORE INSERT OR UPDATE OR DELETE ON "project_track_selections"
  FOR EACH ROW EXECUTE FUNCTION "project_track_selections_guard"();
--> statement-breakpoint

-- 4. Declared sources are immutable rows -------------------------------------------------------
CREATE FUNCTION "project_sources_immutable_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'project sources are immutable; declare a new source instead'
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "project_sources_immutable_guard" BEFORE UPDATE OR DELETE ON "project_sources"
  FOR EACH ROW EXECUTE FUNCTION "project_sources_immutable_guard"();
--> statement-breakpoint

-- 5. Source snapshots: pending exactly once to terminal, then frozen; never deleted -----------
CREATE FUNCTION "source_snapshots_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_next integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'source snapshot % cannot be deleted', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'a source snapshot must be created pending'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Serialize capture-number assignment per declared source; numbers are gapless and monotonic.
    PERFORM 1 FROM "project_sources" WHERE id = NEW.project_source_id FOR UPDATE;
    SELECT COALESCE(MAX(capture_number), 0) + 1 INTO v_next
      FROM "source_snapshots" WHERE project_source_id = NEW.project_source_id;
    IF NEW.capture_number <> v_next THEN
      RAISE EXCEPTION 'capture_number must be % for this source', v_next
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'source snapshot % is terminal (%) and immutable; capture again to create a new snapshot', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'pending' THEN
    RAISE EXCEPTION 'a pending source snapshot may only transition to a terminal status'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.project_id <> OLD.project_id
     OR NEW.project_source_id <> OLD.project_source_id OR NEW.capture_number <> OLD.capture_number
     OR NEW.source_type <> OLD.source_type OR NEW.source_url <> OLD.source_url
     OR NEW.requested_by_actor_id IS DISTINCT FROM OLD.requested_by_actor_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'source snapshot identity is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "source_snapshots_guard" BEFORE INSERT OR UPDATE OR DELETE ON "source_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "source_snapshots_guard"();
--> statement-breakpoint

-- 6. Artifacts: added only while the parent is pending; never changed or deleted --------------
-- FOR SHARE serializes against the finalizing UPDATE of the parent snapshot.
CREATE FUNCTION "source_snapshot_artifacts_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'snapshot artifacts are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT status INTO v_status FROM "source_snapshots" WHERE id = NEW.snapshot_id FOR SHARE;
  IF v_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'artifacts can only be added to a pending snapshot (snapshot is %)', COALESCE(v_status, 'missing')
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "source_snapshot_artifacts_guard" BEFORE INSERT OR UPDATE OR DELETE ON "source_snapshot_artifacts"
  FOR EACH ROW EXECUTE FUNCTION "source_snapshot_artifacts_guard"();
--> statement-breakpoint

-- 7. No bulk erasure of capture history --------------------------------------------------------
CREATE FUNCTION "source_ingestion_no_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% cannot be truncated', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "actors_no_truncate" BEFORE TRUNCATE ON "actors"
  FOR EACH STATEMENT EXECUTE FUNCTION "source_ingestion_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "projects_no_truncate" BEFORE TRUNCATE ON "projects"
  FOR EACH STATEMENT EXECUTE FUNCTION "source_ingestion_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "project_track_selections_no_truncate" BEFORE TRUNCATE ON "project_track_selections"
  FOR EACH STATEMENT EXECUTE FUNCTION "source_ingestion_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "project_sources_no_truncate" BEFORE TRUNCATE ON "project_sources"
  FOR EACH STATEMENT EXECUTE FUNCTION "source_ingestion_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "source_snapshots_no_truncate" BEFORE TRUNCATE ON "source_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION "source_ingestion_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "source_snapshot_artifacts_no_truncate" BEFORE TRUNCATE ON "source_snapshot_artifacts"
  FOR EACH STATEMENT EXECUTE FUNCTION "source_ingestion_no_truncate"();
--> statement-breakpoint

-- 8. Terminal analysis runs never reopen or change -----------------------------------------
CREATE FUNCTION "analysis_runs_terminal_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'analysis run % is terminal (%) and immutable', OLD.id, OLD.state
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.run_type <> OLD.run_type
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.source_snapshot_id IS DISTINCT FROM OLD.source_snapshot_id
     OR NEW.context_version_id IS DISTINCT FROM OLD.context_version_id THEN
    RAISE EXCEPTION 'analysis run identity is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "analysis_runs_terminal_guard" BEFORE UPDATE ON "analysis_runs"
  FOR EACH ROW EXECUTE FUNCTION "analysis_runs_terminal_guard"();
