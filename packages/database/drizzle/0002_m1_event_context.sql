CREATE TABLE "event_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_version_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"authority" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"normalized_text" text NOT NULL,
	"content_hash" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"position" integer NOT NULL,
	"copied_from_id" uuid,
	CONSTRAINT "event_sources_id_context_version_id_key" UNIQUE("id","context_version_id"),
	CONSTRAINT "event_sources_context_version_id_position_key" UNIQUE("context_version_id","position"),
	CONSTRAINT "event_sources_source_type_valid" CHECK (source_type IN ('pasted_text', 'url_text', 'document_text')),
	CONSTRAINT "event_sources_authority_valid" CHECK (authority IN ('official_event_rules', 'official_judging_rubric', 'official_track_rules', 'organizer_guidance', 'judge_context', 'universal_fallback')),
	CONSTRAINT "event_sources_title_length" CHECK (length(btrim(title)) BETWEEN 1 AND 300),
	CONSTRAINT "event_sources_url_format" CHECK (url IS NULL OR (url ~ '^https?://' AND length(url) <= 2048)),
	CONSTRAINT "event_sources_url_text_requires_url" CHECK (source_type <> 'url_text' OR url IS NOT NULL),
	CONSTRAINT "event_sources_text_length" CHECK (length(normalized_text) BETWEEN 1 AND 200000),
	CONSTRAINT "event_sources_content_hash_format" CHECK (content_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "event_sources_position_non_negative" CHECK (position >= 0)
);
--> statement-breakpoint
CREATE TABLE "rubric_anchors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"criterion_id" uuid NOT NULL,
	"score" double precision NOT NULL,
	"description" text NOT NULL,
	CONSTRAINT "rubric_anchors_criterion_id_score_key" UNIQUE("criterion_id","score"),
	CONSTRAINT "rubric_anchors_description_not_blank" CHECK (length(btrim(description)) > 0)
);
--> statement-breakpoint
CREATE TABLE "rubric_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rubric_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"weight" double precision,
	"display_order" integer NOT NULL,
	"source_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"origin" text NOT NULL,
	"human_modified" boolean DEFAULT false NOT NULL,
	CONSTRAINT "rubric_criteria_rubric_id_key_key" UNIQUE("rubric_id","key"),
	CONSTRAINT "rubric_criteria_rubric_id_display_order_key" UNIQUE("rubric_id","display_order"),
	CONSTRAINT "rubric_criteria_key_format" CHECK (key ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "rubric_criteria_weight_range" CHECK (weight IS NULL OR (weight > 0 AND weight <= 1)),
	CONSTRAINT "rubric_criteria_origin_valid" CHECK (origin IN ('source_derived', 'human'))
);
--> statement-breakpoint
CREATE TABLE "rubrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_version_id" uuid NOT NULL,
	"track_id" uuid,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"scale_min" double precision NOT NULL,
	"scale_max" double precision NOT NULL,
	"display_order" integer NOT NULL,
	"source_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"origin" text NOT NULL,
	"human_modified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rubrics_track_id_key" UNIQUE("track_id"),
	CONSTRAINT "rubrics_context_version_id_display_order_key" UNIQUE("context_version_id","display_order"),
	CONSTRAINT "rubrics_scope_valid" CHECK (scope IN ('overall', 'track')),
	CONSTRAINT "rubrics_scope_matches_track" CHECK ((scope = 'overall') = (track_id IS NULL)),
	CONSTRAINT "rubrics_scale_valid" CHECK (scale_min < scale_max),
	CONSTRAINT "rubrics_name_not_blank" CHECK (length(btrim(name)) > 0),
	CONSTRAINT "rubrics_origin_valid" CHECK (origin IN ('source_derived', 'human'))
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_version_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"display_order" integer NOT NULL,
	"source_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"origin" text NOT NULL,
	"human_modified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracks_context_version_id_key_key" UNIQUE("context_version_id","key"),
	CONSTRAINT "tracks_context_version_id_display_order_key" UNIQUE("context_version_id","display_order"),
	CONSTRAINT "tracks_id_context_version_id_key" UNIQUE("id","context_version_id"),
	CONSTRAINT "tracks_key_format" CHECK (key ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "tracks_name_not_blank" CHECK (length(btrim(name)) > 0),
	CONSTRAINT "tracks_display_order_non_negative" CHECK (display_order >= 0),
	CONSTRAINT "tracks_origin_valid" CHECK (origin IN ('source_derived', 'human'))
);
--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "context_version_id" uuid;--> statement-breakpoint
ALTER TABLE "event_context_versions" ADD COLUMN "content" jsonb;--> statement-breakpoint
ALTER TABLE "event_context_versions" ADD COLUMN "extracted_content" jsonb;--> statement-breakpoint
ALTER TABLE "event_context_versions" ADD COLUMN "locked_content_hash" text;--> statement-breakpoint
ALTER TABLE "event_sources" ADD CONSTRAINT "event_sources_context_version_id_event_context_versions_id_fk" FOREIGN KEY ("context_version_id") REFERENCES "public"."event_context_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_sources" ADD CONSTRAINT "event_sources_copied_from_id_event_sources_id_fk" FOREIGN KEY ("copied_from_id") REFERENCES "public"."event_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rubric_anchors" ADD CONSTRAINT "rubric_anchors_criterion_id_rubric_criteria_id_fk" FOREIGN KEY ("criterion_id") REFERENCES "public"."rubric_criteria"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rubric_criteria" ADD CONSTRAINT "rubric_criteria_rubric_id_rubrics_id_fk" FOREIGN KEY ("rubric_id") REFERENCES "public"."rubrics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rubrics" ADD CONSTRAINT "rubrics_context_version_id_event_context_versions_id_fk" FOREIGN KEY ("context_version_id") REFERENCES "public"."event_context_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rubrics" ADD CONSTRAINT "rubrics_track_same_version_fk" FOREIGN KEY ("track_id","context_version_id") REFERENCES "public"."tracks"("id","context_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_context_version_id_event_context_versions_id_fk" FOREIGN KEY ("context_version_id") REFERENCES "public"."event_context_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_sources_context_version_id_idx" ON "event_sources" USING btree ("context_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rubrics_one_overall_per_version" ON "rubrics" USING btree ("context_version_id") WHERE scope = 'overall';--> statement-breakpoint
CREATE INDEX "rubrics_context_version_id_idx" ON "rubrics" USING btree ("context_version_id");--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_context_version_id_event_context_versions_id_fk" FOREIGN KEY ("context_version_id") REFERENCES "public"."event_context_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_runs_context_version_id_idx" ON "analysis_runs" USING btree ("context_version_id");--> statement-breakpoint
ALTER TABLE "event_context_versions" ADD CONSTRAINT "event_context_versions_locked_content_hash_format" CHECK (locked_content_hash IS NULL OR locked_content_hash ~ '^[0-9a-f]{64}$');