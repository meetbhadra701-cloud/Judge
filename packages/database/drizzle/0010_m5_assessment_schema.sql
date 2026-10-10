CREATE TABLE "assessment_dimension_judgments" (
	"assessment_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"dimension_id" text NOT NULL,
	"position" integer NOT NULL,
	"outcome_kind" text NOT NULL,
	"score" double precision,
	"disposition" text NOT NULL,
	"rationale" text,
	"limitations" text[] DEFAULT '{}'::text[] NOT NULL,
	"assessor_attempts" integer NOT NULL,
	"critic_attempts" integer NOT NULL,
	"assessor_call_seqs" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"critic_call_seqs" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"semantic_relevance" text DEFAULT 'not_verified' NOT NULL,
	"critic_review_required" boolean NOT NULL,
	"critic_reviewed" boolean NOT NULL,
	CONSTRAINT "assessment_dimension_judgments_pkey" PRIMARY KEY("assessment_id","dimension_id"),
	CONSTRAINT "assessment_dimension_judgments_position_key" UNIQUE("assessment_id","position"),
	CONSTRAINT "assessment_dimension_judgments_dimension_format" CHECK (dimension_id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
	CONSTRAINT "assessment_dimension_judgments_outcome_valid" CHECK (outcome_kind IN ('scored', 'insufficient_evidence') AND ((outcome_kind = 'scored') = (score IS NOT NULL))),
	CONSTRAINT "assessment_dimension_judgments_disposition_matches_outcome" CHECK ((disposition = 'scored') = (outcome_kind = 'scored')),
	CONSTRAINT "assessment_dimension_judgments_counts_valid" CHECK (assessor_attempts >= 0 AND critic_attempts >= 0 AND position >= 0),
	CONSTRAINT "assessment_dimension_judgments_semantic_literal" CHECK (semantic_relevance = 'not_verified'),
	CONSTRAINT "assessment_dimension_judgments_track_review_required" CHECK (NOT (dimension_id LIKE 'track\_prize\_alignment.%' AND outcome_kind = 'scored') OR critic_review_required),
	CONSTRAINT "assessment_dimension_judgments_review_completed" CHECK ((NOT critic_review_required OR critic_reviewed) AND (NOT critic_reviewed OR cardinality(critic_call_seqs) > 0)),
	CONSTRAINT "assessment_dimension_judgments_disposition_valid" CHECK (disposition IN ('scored', 'assessor_reported_insufficient', 'no_candidate_evidence', 'no_satisfiable_need', 'no_official_requirement_available', 'event_reference_only', 'no_project_derived_citation', 'no_applicable_context_cited', 'no_declared_need_satisfied', 'marked_insufficient_by_critic', 'assessor_output_invalid', 'critic_unavailable', 'provider_refused', 'official_requirement_omitted_by_limit'))
);
--> statement-breakpoint
CREATE TABLE "assessment_judgment_citations" (
	"assessment_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"dimension_id" text NOT NULL,
	"position" integer NOT NULL,
	"evidence_id" uuid NOT NULL,
	"directness" text NOT NULL,
	"specificity" text NOT NULL,
	"note" text,
	"reference_applicability" text,
	"reference_track_key" text,
	CONSTRAINT "assessment_judgment_citations_pkey" PRIMARY KEY("assessment_id","dimension_id","position"),
	CONSTRAINT "assessment_judgment_citations_evidence_key" UNIQUE("assessment_id","dimension_id","evidence_id"),
	CONSTRAINT "assessment_judgment_citations_position_valid" CHECK (position >= 0),
	CONSTRAINT "assessment_judgment_citations_reference_shape" CHECK ((reference_applicability IS NULL AND reference_track_key IS NULL)
        OR (reference_applicability = 'overall_rule' AND reference_track_key IS NULL)
        OR (reference_applicability IN ('declared_track_definition', 'track_specific_requirement') AND reference_track_key IS NOT NULL)),
	CONSTRAINT "assessment_judgment_citations_event_reference_classification" CHECK (reference_applicability IS NULL OR (directness = 'indirect' AND specificity = 'generic'))
);
--> statement-breakpoint
CREATE TABLE "assessment_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"mode" text NOT NULL,
	"run_id" uuid,
	"assessment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_requests_actor_key_key" UNIQUE("actor_id","idempotency_key"),
	CONSTRAINT "assessment_requests_run_id_key" UNIQUE("run_id"),
	CONSTRAINT "assessment_requests_key_format" CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
	CONSTRAINT "assessment_requests_request_hash_hex" CHECK (request_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assessment_requests_mode_valid" CHECK (mode IN ('assess', 'reassess')),
	CONSTRAINT "assessment_requests_exactly_one_outcome" CHECK ((run_id IS NOT NULL) <> (assessment_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "assessment_run_budget" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"max_calls" integer NOT NULL,
	"max_input_tokens" bigint NOT NULL,
	"max_output_tokens" bigint NOT NULL,
	"max_cost_nano_usd" bigint NOT NULL,
	"max_reserved_input_tokens_per_call" bigint NOT NULL,
	"run_wall_clock_ms" bigint NOT NULL,
	"price_table_id" text NOT NULL,
	CONSTRAINT "assessment_run_budget_limits_positive" CHECK (max_calls > 0 AND max_input_tokens > 0 AND max_output_tokens > 0 AND max_cost_nano_usd > 0 AND max_reserved_input_tokens_per_call > 0 AND run_wall_clock_ms > 0 AND max_input_tokens <= 9007199254740991 AND max_output_tokens <= 9007199254740991 AND max_cost_nano_usd <= 9007199254740991 AND run_wall_clock_ms <= 9007199254740991),
	CONSTRAINT "assessment_run_budget_price_table_format" CHECK (price_table_id ~ '^prices/v[0-9]+$')
);
--> statement-breakpoint
CREATE TABLE "assessment_run_calls" (
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"stage" text NOT NULL,
	"attempt" integer NOT NULL,
	"model" text NOT NULL,
	"provider" text,
	"provider_mode" text,
	"request_digest" text NOT NULL,
	"prompt_id" text,
	"prompt_version" text,
	"prompt_template_hash" text,
	"schema_id" text,
	"schema_version" text,
	"generation_settings" jsonb,
	"closed_set" jsonb,
	"closed_set_hash" text,
	"reserved_input_tokens" bigint NOT NULL,
	"reserved_output_tokens" bigint NOT NULL,
	"reserved_cost_nano_usd" bigint NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"usage_basis" text,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"cost_nano_usd" bigint,
	"outcome_code" text,
	"response_hash" text,
	"response_canonical" text,
	"response_record" text DEFAULT 'none' NOT NULL,
	"response_bytes" integer,
	"bound_violation" boolean DEFAULT false NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "assessment_run_calls_pkey" PRIMARY KEY("run_id","seq"),
	CONSTRAINT "assessment_run_calls_run_digest_attempt_key" UNIQUE("run_id","request_digest","attempt"),
	CONSTRAINT "assessment_run_calls_seq_positive" CHECK (seq >= 1 AND attempt >= 1),
	CONSTRAINT "assessment_run_calls_state_valid" CHECK (state IN ('reserved', 'settled', 'released', 'unknown')),
	CONSTRAINT "assessment_run_calls_usage_basis_valid" CHECK (usage_basis IS NULL OR usage_basis IN ('measured', 'estimated', 'unknown_reserved')),
	CONSTRAINT "assessment_run_calls_response_record_valid" CHECK (response_record IN ('stored', 'too_large', 'unserializable', 'none')),
	CONSTRAINT "assessment_run_calls_digest_format" CHECK (length(request_digest) BETWEEN 1 AND 128 AND request_digest !~ '[[:space:]]'),
	CONSTRAINT "assessment_run_calls_response_hash_format" CHECK (response_hash IS NULL OR (length(response_hash) BETWEEN 1 AND 128 AND response_hash !~ '[[:space:]]')),
	CONSTRAINT "assessment_run_calls_closed_set_hash_hex" CHECK (closed_set_hash IS NULL OR closed_set_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assessment_run_calls_template_hash_hex" CHECK (prompt_template_hash IS NULL OR prompt_template_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assessment_run_calls_reserved_input_valid" CHECK (reserved_input_tokens IS NULL OR (reserved_input_tokens >= 0 AND reserved_input_tokens <= 9007199254740991)),
	CONSTRAINT "assessment_run_calls_reserved_output_valid" CHECK (reserved_output_tokens IS NULL OR (reserved_output_tokens >= 0 AND reserved_output_tokens <= 9007199254740991)),
	CONSTRAINT "assessment_run_calls_reserved_cost_valid" CHECK (reserved_cost_nano_usd IS NULL OR (reserved_cost_nano_usd >= 0 AND reserved_cost_nano_usd <= 9007199254740991)),
	CONSTRAINT "assessment_run_calls_input_valid" CHECK (input_tokens IS NULL OR (input_tokens >= 0 AND input_tokens <= 9007199254740991)),
	CONSTRAINT "assessment_run_calls_output_valid" CHECK (output_tokens IS NULL OR (output_tokens >= 0 AND output_tokens <= 9007199254740991)),
	CONSTRAINT "assessment_run_calls_cost_valid" CHECK (cost_nano_usd IS NULL OR (cost_nano_usd >= 0 AND cost_nano_usd <= 9007199254740991)),
	CONSTRAINT "assessment_run_calls_state_shape" CHECK ((
        (state = 'reserved' AND usage_basis IS NULL AND input_tokens IS NULL AND output_tokens IS NULL AND cost_nano_usd IS NULL AND outcome_code IS NULL AND settled_at IS NULL)
        OR (state = 'settled' AND usage_basis IN ('measured', 'estimated') AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND cost_nano_usd IS NOT NULL AND outcome_code IS NOT NULL AND settled_at IS NOT NULL)
        OR (state = 'released' AND usage_basis IS NULL AND input_tokens IS NULL AND output_tokens IS NULL AND cost_nano_usd IS NULL AND outcome_code IS NOT NULL AND settled_at IS NOT NULL)
        OR (state = 'unknown' AND usage_basis = 'unknown_reserved' AND input_tokens = reserved_input_tokens AND output_tokens = reserved_output_tokens AND cost_nano_usd = reserved_cost_nano_usd AND outcome_code IS NOT NULL AND settled_at IS NOT NULL)
      )),
	CONSTRAINT "assessment_run_calls_response_shape" CHECK ((state = 'settled' OR (response_record = 'none' AND response_canonical IS NULL AND response_hash IS NULL AND response_bytes IS NULL))
        AND ((response_record = 'stored') = (response_canonical IS NOT NULL))
        AND (response_canonical IS NULL OR octet_length(response_canonical) <= 262144)
        AND (response_record <> 'stored' OR response_bytes = octet_length(response_canonical))),
	CONSTRAINT "assessment_run_calls_closed_set_shape" CHECK ((closed_set IS NULL) = (closed_set_hash IS NULL) AND (closed_set IS NULL OR (jsonb_typeof(closed_set) = 'object' AND pg_column_size(closed_set) <= 524288))),
	CONSTRAINT "assessment_run_calls_settings_shape" CHECK (generation_settings IS NULL OR (jsonb_typeof(generation_settings) = 'object' AND pg_column_size(generation_settings) <= 8192)),
	CONSTRAINT "assessment_run_calls_outcome_code_format" CHECK (outcome_code IS NULL OR outcome_code ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "assessment_run_extractions" (
	"run_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"extraction_id" uuid NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_run_extractions_pkey" PRIMARY KEY("run_id","kind"),
	CONSTRAINT "assessment_run_extractions_kind_valid" CHECK (kind IN ('source', 'context_evidence'))
);
--> statement-breakpoint
CREATE TABLE "assessment_run_input_snapshots" (
	"run_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"snapshot_content_hash" text NOT NULL,
	CONSTRAINT "assessment_run_input_snapshots_pkey" PRIMARY KEY("run_id","snapshot_id"),
	CONSTRAINT "assessment_run_input_snapshots_hash_hex" CHECK (snapshot_content_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "assessment_run_inputs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"context_version_id" uuid NOT NULL,
	"locked_content_hash" text NOT NULL,
	"declared_track_keys" text[] NOT NULL,
	"track_selection_ids" uuid[] NOT NULL,
	"track_selection_set_hash" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_track_key" text,
	"inputs_fingerprint" text NOT NULL,
	"pipeline_config" jsonb NOT NULL,
	"pipeline_config_hash" text NOT NULL,
	"requested_by_actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_run_inputs_run_context_key" UNIQUE("run_id","context_version_id"),
	CONSTRAINT "assessment_run_inputs_locked_hash_hex" CHECK (locked_content_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assessment_run_inputs_selection_hash_hex" CHECK (track_selection_set_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assessment_run_inputs_fingerprint_hex" CHECK (inputs_fingerprint ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assessment_run_inputs_config_hash_hex" CHECK (pipeline_config_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assessment_run_inputs_target_valid" CHECK (target_kind IN ('overall', 'track') AND ((target_kind = 'track') = (target_track_key IS NOT NULL))),
	CONSTRAINT "assessment_run_inputs_track_arrays_match" CHECK (cardinality(declared_track_keys) = cardinality(track_selection_ids) AND array_position(declared_track_keys, NULL) IS NULL AND array_position(track_selection_ids, NULL) IS NULL),
	CONSTRAINT "assessment_run_inputs_config_is_object" CHECK (jsonb_typeof(pipeline_config) = 'object')
);
--> statement-breakpoint
CREATE TABLE "assessment_run_outcomes" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"failure_category" text,
	"failure_code" text,
	"stage_reached" text,
	"provider_mode" text,
	"attempts_started" integer NOT NULL,
	"settled_calls" integer NOT NULL,
	"unknown_calls" integer NOT NULL,
	"released_calls" integer NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cost_nano_usd" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_run_outcomes_outcome_valid" CHECK (outcome IN ('succeeded', 'failed', 'cancelled')),
	CONSTRAINT "assessment_run_outcomes_failure_matches_outcome" CHECK ((outcome = 'failed') = (failure_category IS NOT NULL)),
	CONSTRAINT "assessment_run_outcomes_codes_format" CHECK ((failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_]*$') AND (stage_reached IS NULL OR stage_reached ~ '^[a-z][a-z0-9_]*$')),
	CONSTRAINT "assessment_run_outcomes_counts_valid" CHECK (attempts_started = settled_calls + unknown_calls + released_calls AND attempts_started >= 0 AND input_tokens >= 0 AND output_tokens >= 0 AND cost_nano_usd >= 0)
);
--> statement-breakpoint
CREATE TABLE "graph_extraction_items" (
	"record_type" text NOT NULL,
	"record_id" uuid NOT NULL,
	"extraction_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"role" text,
	"grounding" text,
	"relation_basis" text,
	"reference_builder" text,
	"reference_kind" text,
	"reference_applicability" text,
	"reference_track_key" text,
	CONSTRAINT "graph_extraction_items_pkey" PRIMARY KEY("record_type","record_id"),
	CONSTRAINT "graph_extraction_items_ordinal_key" UNIQUE("extraction_id","record_type","ordinal"),
	CONSTRAINT "graph_extraction_items_type_valid" CHECK (record_type IN ('claim', 'evidence', 'relation', 'unknown', 'contradiction')),
	CONSTRAINT "graph_extraction_items_ordinal_positive" CHECK (ordinal >= 1),
	CONSTRAINT "graph_extraction_items_role_shape" CHECK ((record_type = 'evidence') = (role IS NOT NULL)),
	CONSTRAINT "graph_extraction_items_grounding_shape" CHECK (grounding IS NULL OR record_type IN ('claim', 'evidence')),
	CONSTRAINT "graph_extraction_items_basis_shape" CHECK ((record_type = 'relation') = (relation_basis IS NOT NULL)),
	CONSTRAINT "graph_extraction_items_reference_shape" CHECK ((role = 'event_reference') = (reference_builder IS NOT NULL AND reference_kind IS NOT NULL AND reference_applicability IS NOT NULL)
        AND (role = 'event_reference' OR reference_track_key IS NULL)
        AND (reference_applicability IS NULL OR (reference_applicability = 'overall_rule') = (reference_track_key IS NULL)))
);
--> statement-breakpoint
CREATE TABLE "graph_extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"extraction_key" text NOT NULL,
	"snapshot_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"context_version_id" uuid,
	"config_hash" text NOT NULL,
	"claim_count" integer NOT NULL,
	"evidence_count" integer NOT NULL,
	"relation_count" integer NOT NULL,
	"unknown_count" integer NOT NULL,
	"contradiction_count" integer NOT NULL,
	"members_hash" text NOT NULL,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graph_extractions_key_key" UNIQUE("extraction_key"),
	CONSTRAINT "graph_extractions_id_project_id_key" UNIQUE("id","project_id"),
	CONSTRAINT "graph_extractions_kind_valid" CHECK (kind IN ('source', 'context_evidence')),
	CONSTRAINT "graph_extractions_key_hex" CHECK (extraction_key ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "graph_extractions_config_hash_hex" CHECK (config_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "graph_extractions_members_hash_hex" CHECK (members_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "graph_extractions_kind_shape" CHECK ((kind = 'source' AND context_version_id IS NULL AND cardinality(snapshot_ids) >= 1) OR (kind = 'context_evidence' AND context_version_id IS NOT NULL AND cardinality(snapshot_ids) = 0)),
	CONSTRAINT "graph_extractions_counts_valid" CHECK (claim_count >= 0 AND evidence_count >= 0 AND relation_count >= 0 AND unknown_count >= 0 AND contradiction_count >= 0 AND claim_count + evidence_count + relation_count + unknown_count + contradiction_count >= 1)
);
--> statement-breakpoint
CREATE TABLE "pre_interview_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"kind" text DEFAULT 'pre_interview' NOT NULL,
	"assessment_key" text NOT NULL,
	"context_version_id" uuid NOT NULL,
	"locked_content_hash" text NOT NULL,
	"pinned_snapshot_ids" uuid[] NOT NULL,
	"extraction_id" uuid NOT NULL,
	"context_extraction_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"track_key" text,
	"fallback_anchors_version" text,
	"engine_version" text NOT NULL,
	"parameters_hash" text NOT NULL,
	"rubric_fingerprint" text NOT NULL,
	"rubric_source" text NOT NULL,
	"input_fingerprint" text NOT NULL,
	"graph_fingerprint" text NOT NULL,
	"output_hash" text NOT NULL,
	"report_canonical" text NOT NULL,
	"report_text_sha256" text NOT NULL,
	"report" jsonb NOT NULL,
	"limitations" jsonb NOT NULL,
	"pipeline_config_hash" text NOT NULL,
	"provider_mode" text NOT NULL,
	"created_by_actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pre_interview_assessments_run_id_key" UNIQUE("run_id"),
	CONSTRAINT "pre_interview_assessments_key_key" UNIQUE("assessment_key"),
	CONSTRAINT "pre_interview_assessments_project_version_key" UNIQUE("project_id","version_number"),
	CONSTRAINT "pre_interview_assessments_id_project_id_key" UNIQUE("id","project_id"),
	CONSTRAINT "pre_interview_assessments_kind_literal" CHECK (kind = 'pre_interview'),
	CONSTRAINT "pre_interview_assessments_version_positive" CHECK (version_number >= 1),
	CONSTRAINT "pre_interview_assessments_key_hex" CHECK (assessment_key ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pre_interview_assessments_locked_hash_hex" CHECK (locked_content_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pre_interview_assessments_hashes_hex" CHECK (parameters_hash ~ '^[0-9a-f]{64}$' AND rubric_fingerprint ~ '^[0-9a-f]{64}$' AND input_fingerprint ~ '^[0-9a-f]{64}$' AND graph_fingerprint ~ '^[0-9a-f]{64}$' AND output_hash ~ '^[0-9a-f]{64}$' AND report_text_sha256 ~ '^[0-9a-f]{64}$' AND pipeline_config_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pre_interview_assessments_target_valid" CHECK ((target_kind = 'track') = (track_key IS NOT NULL)),
	CONSTRAINT "pre_interview_assessments_distinct_extractions" CHECK (extraction_id <> context_extraction_id),
	CONSTRAINT "pre_interview_assessments_report_is_object" CHECK (jsonb_typeof(report) = 'object' AND jsonb_typeof(limitations) = 'array'),
	CONSTRAINT "pre_interview_assessments_report_bound" CHECK (octet_length(report_canonical) BETWEEN 2 AND 4194304),
	CONSTRAINT "pre_interview_assessments_provider_mode_valid" CHECK (provider_mode IN ('live', 'replay', 'scripted'))
);
--> statement-breakpoint
ALTER TABLE "analysis_runs" DROP CONSTRAINT "analysis_runs_failure_category_valid";--> statement-breakpoint
-- (moved ahead of the foreign keys that reference it; drizzle-kit emits it last)
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_id_project_id_key" UNIQUE("id","project_id");--> statement-breakpoint
ALTER TABLE "assessment_dimension_judgments" ADD CONSTRAINT "assessment_dimension_judgments_assessment_fk" FOREIGN KEY ("assessment_id","project_id") REFERENCES "public"."pre_interview_assessments"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_judgment_citations" ADD CONSTRAINT "assessment_judgment_citations_judgment_fk" FOREIGN KEY ("assessment_id","dimension_id") REFERENCES "public"."assessment_dimension_judgments"("assessment_id","dimension_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_judgment_citations" ADD CONSTRAINT "assessment_judgment_citations_assessment_fk" FOREIGN KEY ("assessment_id","project_id") REFERENCES "public"."pre_interview_assessments"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_judgment_citations" ADD CONSTRAINT "assessment_judgment_citations_evidence_same_project_fk" FOREIGN KEY ("evidence_id","project_id") REFERENCES "public"."evidence_items"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_requests" ADD CONSTRAINT "assessment_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_requests" ADD CONSTRAINT "assessment_requests_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_requests" ADD CONSTRAINT "assessment_requests_assessment_same_project_fk" FOREIGN KEY ("assessment_id","project_id") REFERENCES "public"."pre_interview_assessments"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_requests" ADD CONSTRAINT "assessment_requests_run_same_project_fk" FOREIGN KEY ("run_id","project_id") REFERENCES "public"."analysis_runs"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_run_budget" ADD CONSTRAINT "assessment_run_budget_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_run_calls" ADD CONSTRAINT "assessment_run_calls_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_run_extractions" ADD CONSTRAINT "assessment_run_extractions_run_fk" FOREIGN KEY ("run_id","project_id") REFERENCES "public"."analysis_runs"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_run_extractions" ADD CONSTRAINT "assessment_run_extractions_extraction_fk" FOREIGN KEY ("extraction_id","project_id") REFERENCES "public"."graph_extractions"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_run_input_snapshots" ADD CONSTRAINT "assessment_run_input_snapshots_run_fk" FOREIGN KEY ("run_id","project_id") REFERENCES "public"."analysis_runs"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_run_input_snapshots" ADD CONSTRAINT "assessment_run_input_snapshots_snapshot_same_project_fk" FOREIGN KEY ("snapshot_id","project_id") REFERENCES "public"."source_snapshots"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_run_inputs" ADD CONSTRAINT "assessment_run_inputs_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_run_inputs" ADD CONSTRAINT "assessment_run_inputs_requested_by_actor_id_actors_id_fk" FOREIGN KEY ("requested_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_run_inputs" ADD CONSTRAINT "assessment_run_inputs_run_same_project_fk" FOREIGN KEY ("run_id","project_id") REFERENCES "public"."analysis_runs"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_run_inputs" ADD CONSTRAINT "assessment_run_inputs_project_same_event_fk" FOREIGN KEY ("project_id","event_id") REFERENCES "public"."projects"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_run_inputs" ADD CONSTRAINT "assessment_run_inputs_context_same_event_fk" FOREIGN KEY ("context_version_id","event_id") REFERENCES "public"."event_context_versions"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_run_outcomes" ADD CONSTRAINT "assessment_run_outcomes_run_id_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_run_outcomes" ADD CONSTRAINT "assessment_run_outcomes_run_same_project_fk" FOREIGN KEY ("run_id","project_id") REFERENCES "public"."analysis_runs"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_extraction_items" ADD CONSTRAINT "graph_extraction_items_extraction_same_project_fk" FOREIGN KEY ("extraction_id","project_id") REFERENCES "public"."graph_extractions"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_extractions" ADD CONSTRAINT "graph_extractions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_extractions" ADD CONSTRAINT "graph_extractions_created_by_run_id_analysis_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_extractions" ADD CONSTRAINT "graph_extractions_project_same_event_fk" FOREIGN KEY ("project_id","event_id") REFERENCES "public"."projects"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_extractions" ADD CONSTRAINT "graph_extractions_context_same_event_fk" FOREIGN KEY ("context_version_id","event_id") REFERENCES "public"."event_context_versions"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_interview_assessments" ADD CONSTRAINT "pre_interview_assessments_created_by_actor_id_actors_id_fk" FOREIGN KEY ("created_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_interview_assessments" ADD CONSTRAINT "pre_interview_assessments_run_same_project_fk" FOREIGN KEY ("run_id","project_id") REFERENCES "public"."analysis_runs"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_interview_assessments" ADD CONSTRAINT "pre_interview_assessments_project_same_event_fk" FOREIGN KEY ("project_id","event_id") REFERENCES "public"."projects"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_interview_assessments" ADD CONSTRAINT "pre_interview_assessments_context_same_event_fk" FOREIGN KEY ("context_version_id","event_id") REFERENCES "public"."event_context_versions"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_interview_assessments" ADD CONSTRAINT "pre_interview_assessments_extraction_fk" FOREIGN KEY ("extraction_id","project_id") REFERENCES "public"."graph_extractions"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_interview_assessments" ADD CONSTRAINT "pre_interview_assessments_context_extraction_fk" FOREIGN KEY ("context_extraction_id","project_id") REFERENCES "public"."graph_extractions"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assessment_requests_project_id_idx" ON "assessment_requests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "assessment_run_calls_run_state_idx" ON "assessment_run_calls" USING btree ("run_id","state");--> statement-breakpoint
CREATE INDEX "graph_extraction_items_record_idx" ON "graph_extraction_items" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "graph_extractions_project_id_idx" ON "graph_extractions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "pre_interview_assessments_project_id_idx" ON "pre_interview_assessments" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_runs_one_active_assessment_per_project_idx" ON "analysis_runs" USING btree ("project_id") WHERE run_type = 'pre_interview_assessment' AND state IN ('pending', 'running');--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_assessment_links" CHECK (run_type <> 'pre_interview_assessment' OR (event_id IS NOT NULL AND project_id IS NOT NULL AND context_version_id IS NOT NULL AND source_snapshot_id IS NULL));--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_budget_exceeded_only_for_assessments" CHECK (failure_category IS DISTINCT FROM 'budget_exceeded' OR run_type = 'pre_interview_assessment');--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_failure_category_valid" CHECK (failure_category IS NULL OR failure_category IN ('provider_error', 'schema_validation_failed', 'domain_validation_failed', 'source_unavailable', 'timeout', 'internal_error', 'budget_exceeded'));