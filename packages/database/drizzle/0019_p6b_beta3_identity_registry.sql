-- P6B-beta3 (R9-1): ONE registry of identity ownership for EVERY write path.
--
-- Until 0018 only a recorded submission wrote rows into project_submission_claims. The earlier project/source routes were guarded by reading
-- other projects' rows, and a concurrent transaction's uncommitted rows are invisible to a read, so a legacy declaration and a submission (or two
-- legacy declarations, or two case-variant labels) could each find the identity free and BOTH commit. The unique (event, kind, value) index of the
-- registry is the only structure PostgreSQL can use to serialize such writers: a second INSERT of the same key WAITS for the first transaction and,
-- once it has committed, sees it. So now every GitHub declaration, Devpost declaration and project label claims its key in the registry, in the
-- same transaction as the row it describes, by the same function.
--
-- Historical data is not rewritten: the backfill claims what is unambiguous and skips (ON CONFLICT DO NOTHING) what is already shared, so existing
-- duplicates stay exactly as they were (the integrity report still lists them). Recovery notes: docs/MIGRATIONS.md.

-- 1. The single claim function ---------------------------------------------------------------------------------------------------
CREATE FUNCTION "project_claim"(p_event uuid, p_project uuid, p_kind text, p_value text, p_constraint text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- DO NOTHING waits for a concurrent, uncommitted claim of the same key and then yields to it; the check below runs in a NEW snapshot, so it sees
  -- the winner once it has committed. Claiming a key the same project already holds is a no-op (a submission's project declares its own links).
  INSERT INTO "project_submission_claims" ("event_id", "project_id", "kind", "value")
    VALUES (p_event, p_project, p_kind, p_value)
    ON CONFLICT ("event_id", "kind", "value") DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM "project_submission_claims" c
     WHERE c.event_id = p_event AND c.kind = p_kind AND c.value = p_value AND c.project_id = p_project
  ) THEN
    RAISE EXCEPTION 'another active project of this event already owns this % (%)', p_kind, p_value
      USING ERRCODE = 'unique_violation', CONSTRAINT = p_constraint;
  END IF;
END;
$$;
--> statement-breakpoint

-- 2. A recorded submission claims through the same function (was: plain INSERTs that a project's own claim would now collide with) --------
CREATE OR REPLACE FUNCTION "project_submissions_after_insert"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "project_claim"(NEW.event_id, NEW.project_id, 'github', NEW.github_url, 'project_submissions_link_collision');
  PERFORM "project_claim"(NEW.event_id, NEW.project_id, 'devpost', NEW.devpost_url, 'project_submissions_link_collision');
  PERFORM "project_claim"(NEW.event_id, NEW.project_id, 'name', NEW.name_key, 'project_submissions_name_collision');
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- 3. A project claims its label when it is created -------------------------------------------------------------------------------------
CREATE FUNCTION "projects_claim_name"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "project_claim"(NEW.event_id, NEW.id, 'name', lower(btrim(NEW.name)), 'projects_name_claimed');
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "projects_claim_name" AFTER INSERT ON "projects"
  FOR EACH ROW EXECUTE FUNCTION "projects_claim_name"();
--> statement-breakpoint

-- 4. A project claims every GitHub or Devpost link it declares -----------------------------------------------------------------------------
CREATE FUNCTION "project_sources_claim_link"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_event uuid;
BEGIN
  IF NEW.source_type NOT IN ('github', 'devpost') THEN
    RETURN NEW;
  END IF;
  SELECT p.event_id INTO v_event FROM "projects" p WHERE p.id = NEW.project_id;
  PERFORM "project_claim"(v_event, NEW.project_id, NEW.source_type, NEW.url, 'project_sources_claimed_by_submission');
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "project_sources_claim_link" AFTER INSERT ON "project_sources"
  FOR EACH ROW EXECUTE FUNCTION "project_sources_claim_link"();
--> statement-breakpoint

-- 5. Backfill: claim what is unambiguous; never fail on, and never rewrite, what is already shared ----------------------------------------
-- (a) the label of every active project
INSERT INTO "project_submission_claims" ("event_id", "project_id", "kind", "value")
  SELECT p.event_id, p.id, 'name', lower(btrim(p.name)) FROM "projects" p
   WHERE NOT EXISTS (SELECT 1 FROM "project_voids" v WHERE v.project_id = p.id)
   ORDER BY p.created_at, p.id
  ON CONFLICT ("event_id", "kind", "value") DO NOTHING;
--> statement-breakpoint
-- (b) the links of every active project that holds at most one GitHub and one Devpost link (a project holding several is not a valid single
--     submission and, as before, does not block the correct one); links already owned stay with their owner
INSERT INTO "project_submission_claims" ("event_id", "project_id", "kind", "value")
  SELECT p.event_id, p.id, s.source_type, s.url
    FROM "project_sources" s JOIN "projects" p ON p.id = s.project_id
   WHERE s.source_type IN ('github', 'devpost')
     AND NOT EXISTS (SELECT 1 FROM "project_voids" v WHERE v.project_id = p.id)
     AND (SELECT count(*) FROM "project_sources" s2 WHERE s2.project_id = p.id AND s2.source_type = 'github') <= 1
     AND (SELECT count(*) FROM "project_sources" s2 WHERE s2.project_id = p.id AND s2.source_type = 'devpost') <= 1
   ORDER BY p.created_at, p.id
  ON CONFLICT ("event_id", "kind", "value") DO NOTHING;
--> statement-breakpoint

-- 6. The identity tables cannot be emptied by TRUNCATE (UPDATE and DELETE were already guarded; TRUNCATE bypasses row triggers) --------------
CREATE TRIGGER "project_submissions_no_truncate" BEFORE TRUNCATE ON "project_submissions"
  FOR EACH STATEMENT EXECUTE FUNCTION "source_ingestion_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "project_submission_requests_no_truncate" BEFORE TRUNCATE ON "project_submission_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION "source_ingestion_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "project_submission_claims_no_truncate" BEFORE TRUNCATE ON "project_submission_claims"
  FOR EACH STATEMENT EXECUTE FUNCTION "source_ingestion_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "project_voids_no_truncate" BEFORE TRUNCATE ON "project_voids"
  FOR EACH STATEMENT EXECUTE FUNCTION "source_ingestion_no_truncate"();
--> statement-breakpoint
CREATE TRIGGER "project_replacements_no_truncate" BEFORE TRUNCATE ON "project_replacements"
  FOR EACH STATEMENT EXECUTE FUNCTION "source_ingestion_no_truncate"();
