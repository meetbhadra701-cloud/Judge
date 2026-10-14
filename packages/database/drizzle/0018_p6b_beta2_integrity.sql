-- P6B-beta2: ownership of a submission's identity, explicit void-and-replace, and the database-side invariants that every write path (the
-- submission operation, the legacy project/source routes, direct SQL) must respect. Hand-written: drizzle-kit does not model triggers.
-- Additive over 0015-0017; no earlier migration is edited. Recovery notes: docs/MIGRATIONS.md.
--
-- Lock order used by every function below (and by the application): project row first (FOR SHARE to start work on it, FOR UPDATE to void it),
-- never another lock before it. A voided project accepts no new snapshot, run or source; a void waits for, and refuses on, pending work.

-- 1. Backfill: every recorded submission owns its two links and its name ----------------------------------------------------------
INSERT INTO "project_submission_claims" ("event_id", "project_id", "kind", "value")
  SELECT "event_id", "project_id", 'github', "github_url" FROM "project_submissions"
  UNION ALL SELECT "event_id", "project_id", 'devpost', "devpost_url" FROM "project_submissions"
  UNION ALL SELECT "event_id", "project_id", 'name', "name_key" FROM "project_submissions";
--> statement-breakpoint

-- 2. A submission derives its label key from the project (the database is the authority) and checks every other holder -------------
CREATE FUNCTION "project_submissions_before_insert"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_key text;
BEGIN
  SELECT lower(btrim(p.name)) INTO v_key FROM "projects" p WHERE p.id = NEW.project_id AND p.event_id = NEW.event_id;
  IF v_key IS NOT NULL THEN
    NEW.name_key := v_key;
    -- another ACTIVE project of the event with the same case-folded name (the earlier flow, which only had an exact-name rule)
    IF EXISTS (
      SELECT 1 FROM "projects" p
       WHERE p.event_id = NEW.event_id AND p.id <> NEW.project_id AND lower(btrim(p.name)) = v_key
         AND NOT EXISTS (SELECT 1 FROM "project_voids" v WHERE v.project_id = p.id)
    ) THEN
      RAISE EXCEPTION 'another project of this event already has this name (ignoring letter case)'
        USING ERRCODE = 'unique_violation', CONSTRAINT = 'project_submissions_name_collision';
    END IF;
  END IF;
  -- an earlier-flow project that is not voided and holds at most one GitHub and one Devpost link already owns the link (a project holding several
  -- of either kind is not a valid single submission and, as in the application, does not block the correct one)
  IF EXISTS (
    SELECT 1 FROM "project_sources" s JOIN "projects" p ON p.id = s.project_id
     WHERE p.event_id = NEW.event_id AND p.id <> NEW.project_id
       AND NOT EXISTS (SELECT 1 FROM "project_voids" v WHERE v.project_id = p.id)
       AND ((s.source_type = 'github' AND s.url = NEW.github_url) OR (s.source_type = 'devpost' AND s.url = NEW.devpost_url))
       AND (SELECT count(*) FROM "project_sources" s2 WHERE s2.project_id = p.id AND s2.source_type = 'github') <= 1
       AND (SELECT count(*) FROM "project_sources" s2 WHERE s2.project_id = p.id AND s2.source_type = 'devpost') <= 1
  ) THEN
    RAISE EXCEPTION 'another project of this event already declares this GitHub or Devpost link'
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'project_submissions_link_collision';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "project_submissions_before_insert" BEFORE INSERT ON "project_submissions"
  FOR EACH ROW EXECUTE FUNCTION "project_submissions_before_insert"();
--> statement-breakpoint
CREATE FUNCTION "project_submissions_after_insert"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- the unique (event, kind, value) constraint of the claims table is what makes two active submissions unable to share a link or a label
  INSERT INTO "project_submission_claims" ("event_id", "project_id", "kind", "value") VALUES
    (NEW.event_id, NEW.project_id, 'github', NEW.github_url),
    (NEW.event_id, NEW.project_id, 'devpost', NEW.devpost_url),
    (NEW.event_id, NEW.project_id, 'name', NEW.name_key);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "project_submissions_after_insert" AFTER INSERT ON "project_submissions"
  FOR EACH ROW EXECUTE FUNCTION "project_submissions_after_insert"();
--> statement-breakpoint

-- 3. Claims: never updated; deleted only for a voided project ------------------------------------------------------------------
CREATE FUNCTION "project_submission_claims_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a claim on a link or a label is never updated' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "project_voids" v WHERE v.project_id = OLD.project_id) THEN
    RAISE EXCEPTION 'a claim is released only when its project has been voided' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "project_submission_claims_guard" BEFORE UPDATE OR DELETE ON "project_submission_claims"
  FOR EACH ROW EXECUTE FUNCTION "project_submission_claims_guard"();
--> statement-breakpoint

-- 4. Voids: refused while work is pending; then they release the claims and mark the label. Append-only. -----------------------
CREATE FUNCTION "project_voids_before_insert"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_name text;
BEGIN
  -- FOR UPDATE conflicts with every other lock mode on the project row, so a capture request, an assessment request or a source declaration that
  -- is being written right now finishes first (and is then seen by the checks below) or waits until the void is committed (and is then refused)
  SELECT p.name INTO v_name FROM "projects" p WHERE p.id = NEW.project_id AND p.event_id = NEW.event_id FOR UPDATE;
  IF v_name IS NOT NULL THEN
    NEW.name_before := v_name;
  END IF;
  IF EXISTS (SELECT 1 FROM "source_snapshots" s WHERE s.project_id = NEW.project_id AND s.status = 'pending') THEN
    RAISE EXCEPTION 'a capture of this project is still pending; wait for it to finish before voiding the project'
      USING ERRCODE = 'object_in_use', CONSTRAINT = 'project_voids_pending_work';
  END IF;
  IF EXISTS (SELECT 1 FROM "analysis_runs" r WHERE r.project_id = NEW.project_id AND r.state IN ('pending', 'running')) THEN
    RAISE EXCEPTION 'a run of this project is still pending or running; wait for it to finish before voiding the project'
      USING ERRCODE = 'object_in_use', CONSTRAINT = 'project_voids_pending_work';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "project_voids_before_insert" BEFORE INSERT ON "project_voids"
  FOR EACH ROW EXECUTE FUNCTION "project_voids_before_insert"();
--> statement-breakpoint
CREATE FUNCTION "project_voids_after_insert"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "project_submission_claims" WHERE project_id = NEW.project_id;
  -- the label is the only thing about the project that changes: the old name becomes unmistakably a void one and no longer collides with the
  -- name of the replacement (the original is kept in project_voids.name_before)
  UPDATE "projects"
     SET name = left(name, 150) || ' [voided ' || substr(id::text, 1, 8) || ']', updated_at = now()
   WHERE id = NEW.project_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "project_voids_after_insert" AFTER INSERT ON "project_voids"
  FOR EACH ROW EXECUTE FUNCTION "project_voids_after_insert"();
--> statement-breakpoint
CREATE FUNCTION "project_voids_immutable_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'void and replacement records are append-only' USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "project_voids_immutable_guard" BEFORE UPDATE OR DELETE ON "project_voids"
  FOR EACH ROW EXECUTE FUNCTION "project_voids_immutable_guard"();
--> statement-breakpoint
CREATE TRIGGER "project_replacements_immutable_guard" BEFORE UPDATE OR DELETE ON "project_replacements"
  FOR EACH ROW EXECUTE FUNCTION "project_voids_immutable_guard"();
--> statement-breakpoint

-- 5. A voided project starts no new work ---------------------------------------------------------------------------------------
CREATE FUNCTION "project_not_voided_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- FOR SHARE waits for a void that is being committed, so the check below cannot miss it
  PERFORM 1 FROM "projects" p WHERE p.id = NEW.project_id FOR SHARE;
  IF EXISTS (SELECT 1 FROM "project_voids" v WHERE v.project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'this project has been voided; start the work on its replacement'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'project_not_voided';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "source_snapshots_not_voided_guard" BEFORE INSERT ON "source_snapshots"
  FOR EACH ROW EXECUTE FUNCTION "project_not_voided_guard"();
--> statement-breakpoint
CREATE TRIGGER "analysis_runs_not_voided_guard" BEFORE INSERT ON "analysis_runs"
  FOR EACH ROW EXECUTE FUNCTION "project_not_voided_guard"();
--> statement-breakpoint

-- 6. Source declarations: the same identity rules on every write path (REPLACES the 0016 function; the trigger on project_sources stays) --
CREATE OR REPLACE FUNCTION "project_sources_submission_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_github text;
  v_devpost text;
  v_event uuid;
BEGIN
  PERFORM 1 FROM "projects" p WHERE p.id = NEW.project_id FOR SHARE;
  IF EXISTS (SELECT 1 FROM "project_voids" v WHERE v.project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'this project has been voided; declare the source on its replacement'
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'project_not_voided';
  END IF;
  IF NEW.source_type NOT IN ('github', 'devpost') THEN
    RETURN NEW;
  END IF;
  -- a project of a submission keeps exactly its submission's links (unchanged from 0016)
  SELECT github_url, devpost_url INTO v_github, v_devpost FROM "project_submissions" WHERE project_id = NEW.project_id;
  IF FOUND THEN
    IF (NEW.source_type = 'github' AND NEW.url <> v_github) OR (NEW.source_type = 'devpost' AND NEW.url <> v_devpost) THEN
      RAISE EXCEPTION 'this project belongs to a submission with a different % link; void the project and submit the corrected pair', NEW.source_type
        USING ERRCODE = 'check_violation', CONSTRAINT = 'project_sources_submission_fixed';
    END IF;
  END IF;
  -- a link owned by ANOTHER active submission of the event cannot be declared by this project (the legacy route cannot bypass the identity)
  SELECT p.event_id INTO v_event FROM "projects" p WHERE p.id = NEW.project_id;
  IF EXISTS (
    SELECT 1 FROM "project_submission_claims" c
     WHERE c.event_id = v_event AND c.kind = NEW.source_type AND c.value = NEW.url AND c.project_id <> NEW.project_id
  ) THEN
    RAISE EXCEPTION 'this % link is owned by another submission of the event', NEW.source_type
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'project_sources_claimed_by_submission';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- 7. Project labels: a label owned by an active submission cannot be taken by another project; a label changes only when the project is voided --
CREATE FUNCTION "projects_name_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1 FROM "project_submission_claims" c
       WHERE c.event_id = NEW.event_id AND c.kind = 'name' AND c.value = lower(btrim(NEW.name))
    ) THEN
      RAISE EXCEPTION 'this name (ignoring letter case) belongs to a submission of the event'
        USING ERRCODE = 'unique_violation', CONSTRAINT = 'projects_name_claimed';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.name IS DISTINCT FROM OLD.name AND NOT EXISTS (SELECT 1 FROM "project_voids" v WHERE v.project_id = OLD.id) THEN
    RAISE EXCEPTION 'a project is renamed only when it is voided' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "projects_name_guard" BEFORE INSERT OR UPDATE ON "projects"
  FOR EACH ROW EXECUTE FUNCTION "projects_name_guard"();
--> statement-breakpoint

-- 8. Canonical GitHub and Devpost URLs on the declaration table, whoever writes them. NOT VALID: enforced for every new row; rows written
--    before this migration are not scanned (they were normalized by the application). Run VALIDATE CONSTRAINT to check them (docs/MIGRATIONS.md).
ALTER TABLE "project_sources" ADD CONSTRAINT "project_sources_canonical_url" CHECK (
  (source_type = 'github' AND url ~ '^https://github\.com/[a-z0-9._-]+/[a-z0-9._-]+$' AND url !~ '\.git$')
  OR (source_type = 'devpost' AND url ~ '^https://devpost\.com/software/[a-z0-9]+(-[a-z0-9]+)*$')
  OR source_type NOT IN ('github', 'devpost')
) NOT VALID;
