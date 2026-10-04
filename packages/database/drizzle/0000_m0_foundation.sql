CREATE TABLE "analysis_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid,
	"run_type" text NOT NULL,
	"state" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"failure_category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_runs_run_type_format" CHECK (run_type ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "analysis_runs_state_valid" CHECK (state IN ('running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "analysis_runs_failure_category_valid" CHECK (failure_category IS NULL OR failure_category IN ('provider_error', 'schema_validation_failed', 'domain_validation_failed', 'source_unavailable', 'timeout', 'internal_error')),
	CONSTRAINT "analysis_runs_finished_at_matches_state" CHECK ((state = 'running') = (finished_at IS NULL)),
	CONSTRAINT "analysis_runs_failure_category_matches_state" CHECK ((state = 'failed') = (failure_category IS NOT NULL)),
	CONSTRAINT "analysis_runs_finished_not_before_started" CHECK (finished_at IS NULL OR finished_at >= started_at)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_entity_type_format" CHECK (entity_type ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "audit_events_action_format" CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
	CONSTRAINT "audit_events_metadata_is_object" CHECK (jsonb_typeof(metadata) = 'object')
);
--> statement-breakpoint
CREATE TABLE "event_context_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"supersedes_id" uuid,
	"change_reason" text,
	CONSTRAINT "event_context_versions_event_id_version_key" UNIQUE("event_id","version"),
	CONSTRAINT "event_context_versions_id_event_id_key" UNIQUE("id","event_id"),
	CONSTRAINT "event_context_versions_version_positive" CHECK (version >= 1),
	CONSTRAINT "event_context_versions_status_valid" CHECK (status IN ('draft', 'in_review', 'locked', 'superseded')),
	CONSTRAINT "event_context_versions_locked_at_matches_status" CHECK ((status IN ('locked', 'superseded')) = (locked_at IS NOT NULL)),
	CONSTRAINT "event_context_versions_not_self_superseding" CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"judging_starts_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_slug_key" UNIQUE("slug"),
	CONSTRAINT "events_name_not_blank" CHECK (length(btrim(name)) > 0),
	CONSTRAINT "events_slug_format" CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "events_ends_not_before_starts" CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at >= starts_at)
);
--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_context_versions" ADD CONSTRAINT "event_context_versions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_context_versions" ADD CONSTRAINT "event_context_versions_supersedes_same_event_fk" FOREIGN KEY ("supersedes_id","event_id") REFERENCES "public"."event_context_versions"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_runs_event_id_idx" ON "analysis_runs" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "event_context_versions_one_locked_per_event" ON "event_context_versions" USING btree ("event_id") WHERE status = 'locked';--> statement-breakpoint
CREATE INDEX "event_context_versions_supersedes_id_idx" ON "event_context_versions" USING btree ("supersedes_id");