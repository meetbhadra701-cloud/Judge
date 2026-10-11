ALTER TABLE "assessment_dimension_judgments" DROP CONSTRAINT "assessment_dimension_judgments_review_completed";--> statement-breakpoint
ALTER TABLE "assessment_run_calls" ADD COLUMN "dimension_id" text;--> statement-breakpoint
ALTER TABLE "assessment_run_calls" ADD COLUMN "binding_canonical" text;--> statement-breakpoint
ALTER TABLE "assessment_run_inputs" ADD COLUMN "assessment_key" text;--> statement-breakpoint
ALTER TABLE "assessment_run_inputs" ADD COLUMN "assessment_identity_canonical" text;--> statement-breakpoint
ALTER TABLE "graph_extractions" ADD COLUMN "declared_track_keys" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_extractions" ADD COLUMN "identity_canonical" text;--> statement-breakpoint
ALTER TABLE "graph_extractions" ADD COLUMN "content_fingerprint" text;--> statement-breakpoint
ALTER TABLE "assessment_dimension_judgments" ADD CONSTRAINT "assessment_dimension_judgments_review_completed" CHECK ((outcome_kind <> 'scored' OR NOT critic_review_required OR critic_reviewed) AND (NOT critic_reviewed OR cardinality(critic_call_seqs) > 0));--> statement-breakpoint
ALTER TABLE "assessment_run_calls" ADD CONSTRAINT "assessment_run_calls_stage_valid" CHECK (stage IN ('claim_extraction', 'evidence_interpretation', 'fidelity_review', 'relation_matching', 'relation_verification', 'contradiction_detection', 'unknown_identification', 'dimension_assessment', 'critic'));--> statement-breakpoint
ALTER TABLE "assessment_run_calls" ADD CONSTRAINT "assessment_run_calls_dimension_format" CHECK (dimension_id IS NULL OR (length(dimension_id) <= 128 AND dimension_id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'));--> statement-breakpoint
ALTER TABLE "assessment_run_calls" ADD CONSTRAINT "assessment_run_calls_metadata_formats" CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
        AND (provider IS NULL OR provider ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
        AND (prompt_id IS NULL OR prompt_id ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$')
        AND (prompt_version IS NULL OR prompt_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
        AND (schema_id IS NULL OR schema_id ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$')
        AND (schema_version IS NULL OR schema_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'));--> statement-breakpoint
ALTER TABLE "assessment_run_calls" ADD CONSTRAINT "assessment_run_calls_binding_shape" CHECK ((closed_set IS NOT NULL OR binding_canonical IS NULL) AND (binding_canonical IS NULL OR octet_length(binding_canonical) BETWEEN 2 AND 1048576));--> statement-breakpoint
ALTER TABLE "assessment_run_inputs" ADD CONSTRAINT "assessment_run_inputs_identity_shape" CHECK ((assessment_key IS NULL) = (assessment_identity_canonical IS NULL)
        AND (assessment_key IS NULL OR (assessment_key ~ '^[0-9a-f]{64}$' AND octet_length(assessment_identity_canonical) BETWEEN 2 AND 65536)));--> statement-breakpoint
ALTER TABLE "graph_extractions" ADD CONSTRAINT "graph_extractions_identity_shape" CHECK ((identity_canonical IS NULL) = (content_fingerprint IS NULL)
        AND (content_fingerprint IS NULL OR (content_fingerprint ~ '^[0-9a-f]{64}$' AND octet_length(identity_canonical) BETWEEN 2 AND 262144))
        AND (kind = 'context_evidence' OR cardinality(declared_track_keys) = 0));