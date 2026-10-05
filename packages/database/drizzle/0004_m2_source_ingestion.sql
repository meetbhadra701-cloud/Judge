CREATE TABLE "actors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actors_issuer_subject_key" UNIQUE("issuer","subject"),
	CONSTRAINT "actors_issuer_length" CHECK (length(issuer) BETWEEN 1 AND 512),
	CONSTRAINT "actors_subject_length" CHECK (length(subject) BETWEEN 1 AND 255)
);
--> statement-breakpoint
CREATE TABLE "project_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"url" text NOT NULL,
	"position" integer NOT NULL,
	"created_by_actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_sources_project_type_url_key" UNIQUE("project_id","source_type","url"),
	CONSTRAINT "project_sources_project_id_position_key" UNIQUE("project_id","position"),
	CONSTRAINT "project_sources_identity_key" UNIQUE("id","project_id","source_type","url"),
	CONSTRAINT "project_sources_source_type_valid" CHECK (source_type IN ('devpost', 'github', 'deployment', 'video')),
	CONSTRAINT "project_sources_url_format" CHECK (url ~ '^https?://[^[:space:]]+$' AND length(url) <= 2048),
	CONSTRAINT "project_sources_position_non_negative" CHECK (position >= 0)
);
--> statement-breakpoint
CREATE TABLE "project_track_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"context_version_id" uuid NOT NULL,
	"track_id" uuid NOT NULL,
	"track_key" text NOT NULL,
	"declared_by_actor_id" uuid,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_track_selections_project_id_track_id_key" UNIQUE("project_id","track_id"),
	CONSTRAINT "project_track_selections_project_version_key_key" UNIQUE("project_id","context_version_id","track_key")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"team_name" text,
	"created_by_actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_event_id_name_key" UNIQUE("event_id","name"),
	CONSTRAINT "projects_id_event_id_key" UNIQUE("id","event_id"),
	CONSTRAINT "projects_name_length" CHECK (length(btrim(name)) BETWEEN 1 AND 200),
	CONSTRAINT "projects_team_name_length" CHECK (team_name IS NULL OR length(btrim(team_name)) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "source_snapshot_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"artifact_key" text NOT NULL,
	"artifact_kind" text NOT NULL,
	"media_type" text NOT NULL,
	"text_content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"byte_length" integer NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_snapshot_artifacts_snapshot_key_key" UNIQUE("snapshot_id","artifact_key"),
	CONSTRAINT "source_snapshot_artifacts_kind_valid" CHECK (artifact_kind IN ('repository_metadata', 'commit_history', 'tree', 'file', 'omissions', 'submission', 'submission_text', 'http_response', 'page_metadata', 'page_text', 'video_metadata')),
	CONSTRAINT "source_snapshot_artifacts_key_length" CHECK (length(artifact_key) BETWEEN 1 AND 1024),
	CONSTRAINT "source_snapshot_artifacts_media_type_format" CHECK (media_type ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$'),
	CONSTRAINT "source_snapshot_artifacts_byte_length" CHECK (byte_length = octet_length(convert_to(text_content, 'UTF8')) AND byte_length <= 4194304),
	CONSTRAINT "source_snapshot_artifacts_content_hash" CHECK (content_hash = encode(sha256(convert_to(text_content, 'UTF8')), 'hex')),
	CONSTRAINT "source_snapshot_artifacts_metadata_bounded" CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 65536)
);
--> statement-breakpoint
CREATE TABLE "source_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"project_source_id" uuid NOT NULL,
	"capture_number" integer NOT NULL,
	"source_type" text NOT NULL,
	"source_url" text NOT NULL,
	"status" text NOT NULL,
	"revision" text,
	"metadata" jsonb,
	"content_hash" text,
	"partial_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"failure_category" text,
	"failure_metadata" jsonb,
	"requested_by_actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"captured_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "source_snapshots_source_capture_number_key" UNIQUE("project_source_id","capture_number"),
	CONSTRAINT "source_snapshots_id_project_id_key" UNIQUE("id","project_id"),
	CONSTRAINT "source_snapshots_status_valid" CHECK (status IN ('pending', 'captured', 'partial', 'failed', 'rejected')),
	CONSTRAINT "source_snapshots_source_type_valid" CHECK (source_type IN ('devpost', 'github', 'deployment', 'video')),
	CONSTRAINT "source_snapshots_capture_number_positive" CHECK (capture_number >= 1),
	CONSTRAINT "source_snapshots_failure_category_valid" CHECK (failure_category IS NULL OR failure_category IN ('invalid_url', 'unsupported_source', 'ssrf_rejected', 'too_many_redirects', 'dns_failure', 'timeout', 'tls_failure', 'connection_failure', 'response_too_large', 'unsupported_content_type', 'http_api_error', 'rate_limited', 'not_found', 'parse_failure', 'internal_error')),
	CONSTRAINT "source_snapshots_completed_at_matches_status" CHECK ((status = 'pending') = (completed_at IS NULL)),
	CONSTRAINT "source_snapshots_content_matches_status" CHECK ((status IN ('captured', 'partial')) = (captured_at IS NOT NULL AND content_hash IS NOT NULL AND metadata IS NOT NULL)),
	CONSTRAINT "source_snapshots_content_fields_only_with_content" CHECK (status IN ('captured', 'partial') OR (captured_at IS NULL AND content_hash IS NULL AND metadata IS NULL AND revision IS NULL)),
	CONSTRAINT "source_snapshots_failure_matches_status" CHECK ((status IN ('failed', 'rejected')) = (failure_category IS NOT NULL AND failure_metadata IS NOT NULL)),
	CONSTRAINT "source_snapshots_failure_fields_only_on_failure" CHECK (status IN ('failed', 'rejected') OR (failure_category IS NULL AND failure_metadata IS NULL)),
	CONSTRAINT "source_snapshots_rejection_category" CHECK (status <> 'rejected' OR failure_category IN ('invalid_url', 'unsupported_source', 'ssrf_rejected', 'too_many_redirects')),
	CONSTRAINT "source_snapshots_failed_category" CHECK (status <> 'failed' OR failure_category NOT IN ('invalid_url', 'unsupported_source', 'ssrf_rejected', 'too_many_redirects')),
	CONSTRAINT "source_snapshots_partial_reasons_match_status" CHECK ((status = 'partial') = (cardinality(partial_reasons) > 0)),
	CONSTRAINT "source_snapshots_partial_reasons_valid" CHECK (partial_reasons <@ ARRAY['tree_truncated', 'tree_entry_limit', 'commit_limit', 'file_size_limit', 'file_count_limit', 'total_text_limit', 'blob_unavailable', 'time_budget_exhausted', 'body_truncated', 'body_not_captured', 'sections_missing', 'generic_metadata_only']::text[]),
	CONSTRAINT "source_snapshots_revision_format" CHECK (revision IS NULL OR revision ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "source_snapshots_github_revision" CHECK ((source_type = 'github' AND status IN ('captured', 'partial')) = (revision IS NOT NULL)),
	CONSTRAINT "source_snapshots_content_hash_format" CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "source_snapshots_failure_metadata_safe" CHECK (failure_metadata IS NULL OR (jsonb_typeof(failure_metadata) = 'object' AND (failure_metadata - ARRAY['adapter', 'reason', 'host', 'httpStatus', 'elapsedMs', 'retryAfterSeconds', 'limit', 'limitValue', 'attempts', 'redirectCount']::text[]) = '{}'::jsonb AND octet_length(failure_metadata::text) <= 4096)),
	CONSTRAINT "source_snapshots_metadata_bounded" CHECK (metadata IS NULL OR (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 65536)),
	CONSTRAINT "source_snapshots_url_format" CHECK (source_url ~ '^https?://'),
	CONSTRAINT "source_snapshots_timestamps_ordered" CHECK ((completed_at IS NULL OR completed_at >= created_at) AND (captured_at IS NULL OR (captured_at >= created_at AND captured_at <= completed_at)))
);
--> statement-breakpoint
ALTER TABLE "analysis_runs" DROP CONSTRAINT "analysis_runs_state_valid";--> statement-breakpoint
ALTER TABLE "analysis_runs" DROP CONSTRAINT "analysis_runs_finished_at_matches_state";--> statement-breakpoint
ALTER TABLE "analysis_runs" ALTER COLUMN "started_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "source_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_sources" ADD CONSTRAINT "project_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_sources" ADD CONSTRAINT "project_sources_created_by_actor_id_actors_id_fk" FOREIGN KEY ("created_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_track_selections" ADD CONSTRAINT "project_track_selections_declared_by_actor_id_actors_id_fk" FOREIGN KEY ("declared_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_track_selections" ADD CONSTRAINT "project_track_selections_project_same_event_fk" FOREIGN KEY ("project_id","event_id") REFERENCES "public"."projects"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_track_selections" ADD CONSTRAINT "project_track_selections_context_same_event_fk" FOREIGN KEY ("context_version_id","event_id") REFERENCES "public"."event_context_versions"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_track_selections" ADD CONSTRAINT "project_track_selections_track_same_version_fk" FOREIGN KEY ("track_id","context_version_id") REFERENCES "public"."tracks"("id","context_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_actor_id_actors_id_fk" FOREIGN KEY ("created_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_snapshot_artifacts" ADD CONSTRAINT "source_snapshot_artifacts_snapshot_id_source_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."source_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_requested_by_actor_id_actors_id_fk" FOREIGN KEY ("requested_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_declared_source_fk" FOREIGN KEY ("project_source_id","project_id","source_type","source_url") REFERENCES "public"."project_sources"("id","project_id","source_type","url") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_sources_project_id_idx" ON "project_sources" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_track_selections_project_id_idx" ON "project_track_selections" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "source_snapshots_project_id_created_at_idx" ON "source_snapshots" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "source_snapshots_project_source_id_idx" ON "source_snapshots" USING btree ("project_source_id");--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_source_snapshot_id_source_snapshots_id_fk" FOREIGN KEY ("source_snapshot_id") REFERENCES "public"."source_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_snapshot_same_project_fk" FOREIGN KEY ("source_snapshot_id","project_id") REFERENCES "public"."source_snapshots"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_project_same_event_fk" FOREIGN KEY ("project_id","event_id") REFERENCES "public"."projects"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_runs_project_id_idx" ON "analysis_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "analysis_runs_state_run_type_idx" ON "analysis_runs" USING btree ("state","run_type");--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_source_snapshot_id_key" UNIQUE("source_snapshot_id");--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_started_at_matches_state" CHECK ((state = 'pending') = (started_at IS NULL));--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_pending_has_no_lease" CHECK (state <> 'pending' OR (lease_token IS NULL AND lease_expires_at IS NULL));--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_attempt_count_non_negative" CHECK (attempt_count >= 0);--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_capture_links" CHECK (run_type <> 'project_source_capture' OR (event_id IS NOT NULL AND project_id IS NOT NULL AND source_snapshot_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_state_valid" CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_finished_at_matches_state" CHECK ((state IN ('pending', 'running')) = (finished_at IS NULL));