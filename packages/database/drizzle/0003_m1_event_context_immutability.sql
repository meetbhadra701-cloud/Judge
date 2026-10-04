-- M1: Event Context immutability and provenance integrity. Hand-written: drizzle-kit does not
-- model triggers. Normal application paths cannot mutate frozen history; an administrator can
-- still perform an explicit, reviewed data migration by disabling these triggers inside it.

-- 1. Frozen versions ---------------------------------------------------------------------------
-- locked/superseded rows never change, except the single status transition locked -> superseded.
-- Identity columns of drafts (event, version number, base version, creation time) never change.
CREATE FUNCTION "event_context_versions_freeze_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('locked', 'superseded') THEN
      RAISE EXCEPTION 'event context version % is frozen (%) and cannot be deleted', OLD.id, OLD.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('locked', 'superseded') THEN
    IF OLD.status = 'locked' AND NEW.status = 'superseded'
       AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'event context version % is frozen (%); create a new version instead', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.status = 'superseded' THEN
    RAISE EXCEPTION 'only a locked event context version can be superseded'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.event_id <> OLD.event_id OR NEW.version <> OLD.version
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'event context version identity is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "event_context_versions_freeze_guard"
  BEFORE UPDATE OR DELETE ON "event_context_versions"
  FOR EACH ROW EXECUTE FUNCTION "event_context_versions_freeze_guard"();
--> statement-breakpoint

-- 2. Children of frozen versions ---------------------------------------------------------------
-- FOR SHARE serializes against a concurrent lock (which holds FOR UPDATE on the version row).
CREATE FUNCTION "event_context_assert_version_mutable"(p_version_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM "event_context_versions" WHERE id = p_version_id FOR SHARE;
  IF v_status IN ('locked', 'superseded') THEN
    RAISE EXCEPTION 'event context version % is frozen (%); create a new version instead', p_version_id, v_status
      USING ERRCODE = 'restrict_violation';
  END IF;
END;
$$;
--> statement-breakpoint
-- Tables with a direct context_version_id column. Event sources are additionally immutable rows.
CREATE FUNCTION "event_context_child_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'event_sources' THEN
    RAISE EXCEPTION 'event sources are immutable; add a new source instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM "event_context_assert_version_mutable"(OLD.context_version_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM "event_context_assert_version_mutable"(NEW.context_version_id);
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "event_sources_freeze_guard" BEFORE INSERT OR UPDATE OR DELETE ON "event_sources"
  FOR EACH ROW EXECUTE FUNCTION "event_context_child_guard"();
--> statement-breakpoint
CREATE TRIGGER "tracks_freeze_guard" BEFORE INSERT OR UPDATE OR DELETE ON "tracks"
  FOR EACH ROW EXECUTE FUNCTION "event_context_child_guard"();
--> statement-breakpoint
CREATE TRIGGER "rubrics_freeze_guard" BEFORE INSERT OR UPDATE OR DELETE ON "rubrics"
  FOR EACH ROW EXECUTE FUNCTION "event_context_child_guard"();
--> statement-breakpoint
CREATE FUNCTION "rubric_criteria_freeze_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM "event_context_assert_version_mutable"(r.context_version_id)
      FROM "rubrics" r WHERE r.id = OLD.rubric_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM "event_context_assert_version_mutable"(r.context_version_id)
      FROM "rubrics" r WHERE r.id = NEW.rubric_id;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "rubric_criteria_freeze_guard" BEFORE INSERT OR UPDATE OR DELETE ON "rubric_criteria"
  FOR EACH ROW EXECUTE FUNCTION "rubric_criteria_freeze_guard"();
--> statement-breakpoint
CREATE FUNCTION "rubric_anchors_freeze_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM "event_context_assert_version_mutable"(r.context_version_id)
      FROM "rubric_criteria" c JOIN "rubrics" r ON r.id = c.rubric_id WHERE c.id = OLD.criterion_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM "event_context_assert_version_mutable"(r.context_version_id)
      FROM "rubric_criteria" c JOIN "rubrics" r ON r.id = c.rubric_id WHERE c.id = NEW.criterion_id;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "rubric_anchors_freeze_guard" BEFORE INSERT OR UPDATE OR DELETE ON "rubric_anchors"
  FOR EACH ROW EXECUTE FUNCTION "rubric_anchors_freeze_guard"();
--> statement-breakpoint

-- 3. Source references stay inside their own context version -----------------------------------
CREATE FUNCTION "event_context_assert_source_refs"(p_version_id uuid, p_source_ids uuid[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_missing uuid;
BEGIN
  SELECT s INTO v_missing FROM unnest(p_source_ids) AS s
  WHERE NOT EXISTS (
    SELECT 1 FROM "event_sources" es WHERE es.id = s AND es.context_version_id = p_version_id
  )
  LIMIT 1;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'source % is not part of event context version %', v_missing, p_version_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
END;
$$;
--> statement-breakpoint
-- Same reference keys as collectSourceIds() in @judge-copilot/context.
CREATE FUNCTION "event_context_json_source_ids"(p_doc jsonb) RETURNS uuid[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_agg(DISTINCT (ref #>> '{}')::uuid), '{}'::uuid[])
  FROM (
    SELECT jsonb_path_query(p_doc, 'lax $.**.sourceIds[*]') AS ref
    UNION ALL SELECT jsonb_path_query(p_doc, 'lax $.**.prevailingSourceIds[*]')
    UNION ALL SELECT jsonb_path_query(p_doc, 'lax $.**.sourceId')
  ) refs
$$;
--> statement-breakpoint
CREATE FUNCTION "event_context_versions_source_refs"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "event_context_assert_source_refs"(NEW.id, "event_context_json_source_ids"(NEW.content));
  PERFORM "event_context_assert_source_refs"(NEW.id, "event_context_json_source_ids"(NEW.extracted_content));
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "event_context_versions_source_refs"
  BEFORE INSERT OR UPDATE OF content, extracted_content ON "event_context_versions"
  FOR EACH ROW EXECUTE FUNCTION "event_context_versions_source_refs"();
--> statement-breakpoint
CREATE FUNCTION "event_context_structure_source_refs"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "event_context_assert_source_refs"(NEW.context_version_id, NEW.source_ids);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "tracks_source_refs" BEFORE INSERT OR UPDATE ON "tracks"
  FOR EACH ROW EXECUTE FUNCTION "event_context_structure_source_refs"();
--> statement-breakpoint
CREATE TRIGGER "rubrics_source_refs" BEFORE INSERT OR UPDATE ON "rubrics"
  FOR EACH ROW EXECUTE FUNCTION "event_context_structure_source_refs"();
--> statement-breakpoint
CREATE FUNCTION "rubric_criteria_source_refs"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "event_context_assert_source_refs"(r.context_version_id, NEW.source_ids)
    FROM "rubrics" r WHERE r.id = NEW.rubric_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "rubric_criteria_source_refs" BEFORE INSERT OR UPDATE ON "rubric_criteria"
  FOR EACH ROW EXECUTE FUNCTION "rubric_criteria_source_refs"();
