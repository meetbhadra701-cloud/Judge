-- P6B-beta1: submission intents are append-only, and a project that has one never gains a different GitHub or Devpost source.
-- Hand-written: drizzle-kit does not model triggers. Additive; no earlier migration is edited.

-- 1. Both submission tables are append-only ---------------------------------------------------------------------------------------
CREATE FUNCTION "project_submissions_immutable_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'submission records are append-only'
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "project_submissions_immutable_guard" BEFORE UPDATE OR DELETE ON "project_submissions"
  FOR EACH ROW EXECUTE FUNCTION "project_submissions_immutable_guard"();
--> statement-breakpoint
CREATE TRIGGER "project_submission_requests_immutable_guard" BEFORE UPDATE OR DELETE ON "project_submission_requests"
  FOR EACH ROW EXECUTE FUNCTION "project_submissions_immutable_guard"();
--> statement-breakpoint

-- 2. A source declaration may not contradict the project's submission -----------------------------------------------------------
-- The submission fixes exactly one GitHub URL and one Devpost URL. Declaring any OTHER github/devpost source for that project (through
-- any route, or directly) would silently combine two submission intents in one project, so it is refused here. Re-declaring the same URL
-- is the table's own unique constraint (DUPLICATE_SOURCE); video and deployment sources are unaffected.
CREATE FUNCTION "project_sources_submission_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_github text;
  v_devpost text;
BEGIN
  IF NEW.source_type NOT IN ('github', 'devpost') THEN
    RETURN NEW;
  END IF;
  SELECT github_url, devpost_url INTO v_github, v_devpost FROM "project_submissions" WHERE project_id = NEW.project_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF (NEW.source_type = 'github' AND NEW.url <> v_github) OR (NEW.source_type = 'devpost' AND NEW.url <> v_devpost) THEN
    RAISE EXCEPTION 'this project belongs to a submission with a different % link', NEW.source_type
      USING ERRCODE = 'check_violation', CONSTRAINT = 'project_sources_submission_fixed';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "project_sources_submission_guard" BEFORE INSERT ON "project_sources"
  FOR EACH ROW EXECUTE FUNCTION "project_sources_submission_guard"();
--> statement-breakpoint

-- 3. A submission may not be recorded over a project that already holds other links ---------------------------------------------
CREATE FUNCTION "project_submissions_existing_sources_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "project_sources" s
     WHERE s.project_id = NEW.project_id
       AND ((s.source_type = 'github' AND s.url <> NEW.github_url) OR (s.source_type = 'devpost' AND s.url <> NEW.devpost_url))
  ) THEN
    RAISE EXCEPTION 'the project already has a github or devpost source that differs from this submission'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'project_submissions_existing_sources';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "project_submissions_existing_sources_guard" BEFORE INSERT ON "project_submissions"
  FOR EACH ROW EXECUTE FUNCTION "project_submissions_existing_sources_guard"();
