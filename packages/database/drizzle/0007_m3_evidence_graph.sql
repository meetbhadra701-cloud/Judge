CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "claims_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"text" text NOT NULL,
	"verification_level" text NOT NULL,
	"supersedes_id" uuid,
	"created_by_actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claims_seq_key" UNIQUE("seq"),
	CONSTRAINT "claims_id_project_id_key" UNIQUE("id","project_id"),
	CONSTRAINT "claims_supersedes_id_key" UNIQUE("supersedes_id"),
	CONSTRAINT "claims_not_self_superseding" CHECK (supersedes_id IS NULL OR supersedes_id <> id),
	CONSTRAINT "claims_verification_level_valid" CHECK (verification_level IN ('unverified', 'team_claim', 'repo_corroborated', 'machine_verified', 'judge_verified', 'live_verified', 'contradicted')),
	CONSTRAINT "claims_text_valid" CHECK (length(btrim(text)) BETWEEN 1 AND 1000 AND text = normalize(text, NFC)),
	CONSTRAINT "claims_text_single_line" CHECK (text !~ E'[\n\r]')
);
--> statement-breakpoint
CREATE TABLE "contradictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "contradictions_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"side_a_claim_id" uuid,
	"side_a_evidence_id" uuid,
	"side_b_claim_id" uuid,
	"side_b_evidence_id" uuid,
	"side_a_key" text GENERATED ALWAYS AS (CASE WHEN side_a_claim_id IS NOT NULL THEN 'claim:' || side_a_claim_id::text ELSE 'evidence:' || side_a_evidence_id::text END) STORED,
	"side_b_key" text GENERATED ALWAYS AS (CASE WHEN side_b_claim_id IS NOT NULL THEN 'claim:' || side_b_claim_id::text ELSE 'evidence:' || side_b_evidence_id::text END) STORED,
	"description" text NOT NULL,
	"created_by_actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contradictions_seq_key" UNIQUE("seq"),
	CONSTRAINT "contradictions_id_project_id_key" UNIQUE("id","project_id"),
	CONSTRAINT "contradictions_pair_key" UNIQUE("project_id","side_a_key","side_b_key"),
	CONSTRAINT "contradictions_side_a_exactly_one" CHECK ((side_a_claim_id IS NOT NULL) <> (side_a_evidence_id IS NOT NULL)),
	CONSTRAINT "contradictions_side_b_exactly_one" CHECK ((side_b_claim_id IS NOT NULL) <> (side_b_evidence_id IS NOT NULL)),
	CONSTRAINT "contradictions_sides_canonical" CHECK (side_a_key COLLATE "C" < side_b_key COLLATE "C"),
	CONSTRAINT "contradictions_description_valid" CHECK (length(btrim(description)) BETWEEN 1 AND 1000 AND description = normalize(description, NFC))
);
--> statement-breakpoint
CREATE TABLE "evidence_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "evidence_items_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"origin" text NOT NULL,
	"verification_level" text NOT NULL,
	"text" text NOT NULL,
	"snapshot_id" uuid,
	"artifact_id" uuid,
	"span_start" integer,
	"span_end" integer,
	"excerpt" text,
	"context_version_id" uuid,
	"created_by_actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_items_seq_key" UNIQUE("seq"),
	CONSTRAINT "evidence_items_id_project_id_key" UNIQUE("id","project_id"),
	CONSTRAINT "evidence_items_kind_valid" CHECK (kind IN ('fact', 'claim', 'absence', 'unknown', 'contradiction')),
	CONSTRAINT "evidence_items_origin_valid" CHECK (origin IN ('event_context', 'devpost', 'github', 'deployment', 'video', 'team_answer', 'judge_observation')),
	CONSTRAINT "evidence_items_verification_level_valid" CHECK (verification_level IN ('unverified', 'team_claim', 'repo_corroborated', 'machine_verified', 'judge_verified', 'live_verified', 'contradicted')),
	CONSTRAINT "evidence_items_origin_supported_in_m3" CHECK (origin IN ('event_context', 'devpost', 'github', 'deployment', 'video')),
	CONSTRAINT "evidence_items_verification_matrix" CHECK ((origin = 'event_context' AND kind = 'fact' AND verification_level IN ('unverified')) OR (origin = 'event_context' AND kind = 'absence' AND verification_level IN ('unverified')) OR (origin = 'event_context' AND kind = 'unknown' AND verification_level IN ('unverified')) OR (origin = 'event_context' AND kind = 'contradiction' AND verification_level IN ('unverified')) OR (origin = 'devpost' AND kind = 'fact' AND verification_level IN ('unverified', 'team_claim')) OR (origin = 'devpost' AND kind = 'claim' AND verification_level IN ('unverified', 'team_claim')) OR (origin = 'devpost' AND kind = 'absence' AND verification_level IN ('unverified')) OR (origin = 'devpost' AND kind = 'unknown' AND verification_level IN ('unverified')) OR (origin = 'devpost' AND kind = 'contradiction' AND verification_level IN ('unverified')) OR (origin = 'github' AND kind = 'fact' AND verification_level IN ('unverified', 'repo_corroborated', 'machine_verified')) OR (origin = 'github' AND kind = 'claim' AND verification_level IN ('unverified', 'team_claim')) OR (origin = 'github' AND kind = 'absence' AND verification_level IN ('unverified')) OR (origin = 'github' AND kind = 'unknown' AND verification_level IN ('unverified')) OR (origin = 'github' AND kind = 'contradiction' AND verification_level IN ('unverified')) OR (origin = 'deployment' AND kind = 'fact' AND verification_level IN ('unverified', 'machine_verified')) OR (origin = 'deployment' AND kind = 'claim' AND verification_level IN ('unverified', 'team_claim')) OR (origin = 'deployment' AND kind = 'absence' AND verification_level IN ('unverified')) OR (origin = 'deployment' AND kind = 'unknown' AND verification_level IN ('unverified')) OR (origin = 'deployment' AND kind = 'contradiction' AND verification_level IN ('unverified')) OR (origin = 'video' AND kind = 'fact' AND verification_level IN ('unverified', 'team_claim')) OR (origin = 'video' AND kind = 'claim' AND verification_level IN ('unverified', 'team_claim')) OR (origin = 'video' AND kind = 'absence' AND verification_level IN ('unverified')) OR (origin = 'video' AND kind = 'unknown' AND verification_level IN ('unverified')) OR (origin = 'video' AND kind = 'contradiction' AND verification_level IN ('unverified')) OR (origin = 'team_answer' AND kind = 'claim' AND verification_level IN ('unverified', 'team_claim')) OR (origin = 'team_answer' AND kind = 'unknown' AND verification_level IN ('unverified')) OR (origin = 'team_answer' AND kind = 'contradiction' AND verification_level IN ('unverified')) OR (origin = 'judge_observation' AND kind = 'fact' AND verification_level IN ('judge_verified', 'live_verified')) OR (origin = 'judge_observation' AND kind = 'absence' AND verification_level IN ('judge_verified', 'live_verified')) OR (origin = 'judge_observation' AND kind = 'unknown' AND verification_level IN ('unverified')) OR (origin = 'judge_observation' AND kind = 'contradiction' AND verification_level IN ('unverified', 'judge_verified'))),
	CONSTRAINT "evidence_items_text_valid" CHECK (length(btrim(text)) BETWEEN 1 AND 2000 AND text = normalize(text, NFC)),
	CONSTRAINT "evidence_items_source_origin_has_snapshot" CHECK ((origin IN ('devpost', 'github', 'deployment', 'video')) = (snapshot_id IS NOT NULL)),
	CONSTRAINT "evidence_items_context_origin_has_version" CHECK ((origin = 'event_context') = (context_version_id IS NOT NULL)),
	CONSTRAINT "evidence_items_artifact_needs_snapshot" CHECK (artifact_id IS NULL OR snapshot_id IS NOT NULL),
	CONSTRAINT "evidence_items_span_shape" CHECK ((span_start IS NULL) = (span_end IS NULL) AND (span_start IS NULL) = (excerpt IS NULL) AND (span_start IS NULL OR (artifact_id IS NOT NULL AND span_start >= 0 AND span_end > span_start AND span_end - span_start <= 2000 AND char_length(excerpt) = span_end - span_start))),
	CONSTRAINT "evidence_items_level_anchors" CHECK ((verification_level <> 'machine_verified' OR (artifact_id IS NOT NULL AND span_start IS NOT NULL)) AND (verification_level <> 'repo_corroborated' OR artifact_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "evidence_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "evidence_relations_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"relation_type" text NOT NULL,
	"created_by_actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_relations_seq_key" UNIQUE("seq"),
	CONSTRAINT "evidence_relations_claim_evidence_key" UNIQUE("claim_id","evidence_id"),
	CONSTRAINT "evidence_relations_type_valid" CHECK (relation_type IN ('supports', 'contradicts'))
);
--> statement-breakpoint
CREATE TABLE "unknowns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "unknowns_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"unknown_type" text NOT NULL,
	"text" text NOT NULL,
	"claim_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"evidence_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_by_actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unknowns_seq_key" UNIQUE("seq"),
	CONSTRAINT "unknowns_id_project_id_key" UNIQUE("id","project_id"),
	CONSTRAINT "unknowns_type_valid" CHECK (unknown_type IN ('missing', 'ambiguous', 'contradictory', 'unverifiable', 'subjective', 'eligibility')),
	CONSTRAINT "unknowns_text_valid" CHECK (length(btrim(text)) BETWEEN 1 AND 1000 AND text = normalize(text, NFC)),
	CONSTRAINT "unknowns_reference_counts" CHECK (cardinality(claim_ids) <= 50 AND cardinality(evidence_ids) <= 50)
);
--> statement-breakpoint
-- M3 compatibility: a composite foreign key target so evidence can pin an artifact to its snapshot.
ALTER TABLE "source_snapshot_artifacts" ADD CONSTRAINT "source_snapshot_artifacts_id_snapshot_id_key" UNIQUE("id","snapshot_id");--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_created_by_actor_id_actors_id_fk" FOREIGN KEY ("created_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_supersedes_same_project_fk" FOREIGN KEY ("supersedes_id","project_id") REFERENCES "public"."claims"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contradictions" ADD CONSTRAINT "contradictions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contradictions" ADD CONSTRAINT "contradictions_created_by_actor_id_actors_id_fk" FOREIGN KEY ("created_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contradictions" ADD CONSTRAINT "contradictions_side_a_claim_same_project_fk" FOREIGN KEY ("side_a_claim_id","project_id") REFERENCES "public"."claims"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contradictions" ADD CONSTRAINT "contradictions_side_a_evidence_same_project_fk" FOREIGN KEY ("side_a_evidence_id","project_id") REFERENCES "public"."evidence_items"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contradictions" ADD CONSTRAINT "contradictions_side_b_claim_same_project_fk" FOREIGN KEY ("side_b_claim_id","project_id") REFERENCES "public"."claims"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contradictions" ADD CONSTRAINT "contradictions_side_b_evidence_same_project_fk" FOREIGN KEY ("side_b_evidence_id","project_id") REFERENCES "public"."evidence_items"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_created_by_actor_id_actors_id_fk" FOREIGN KEY ("created_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_project_same_event_fk" FOREIGN KEY ("project_id","event_id") REFERENCES "public"."projects"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_snapshot_same_project_fk" FOREIGN KEY ("snapshot_id","project_id") REFERENCES "public"."source_snapshots"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_artifact_same_snapshot_fk" FOREIGN KEY ("artifact_id","snapshot_id") REFERENCES "public"."source_snapshot_artifacts"("id","snapshot_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_context_version_same_event_fk" FOREIGN KEY ("context_version_id","event_id") REFERENCES "public"."event_context_versions"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_relations" ADD CONSTRAINT "evidence_relations_created_by_actor_id_actors_id_fk" FOREIGN KEY ("created_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_relations" ADD CONSTRAINT "evidence_relations_claim_same_project_fk" FOREIGN KEY ("claim_id","project_id") REFERENCES "public"."claims"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_relations" ADD CONSTRAINT "evidence_relations_evidence_same_project_fk" FOREIGN KEY ("evidence_id","project_id") REFERENCES "public"."evidence_items"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unknowns" ADD CONSTRAINT "unknowns_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unknowns" ADD CONSTRAINT "unknowns_created_by_actor_id_actors_id_fk" FOREIGN KEY ("created_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claims_project_id_seq_idx" ON "claims" USING btree ("project_id","seq");--> statement-breakpoint
CREATE INDEX "contradictions_project_id_seq_idx" ON "contradictions" USING btree ("project_id","seq");--> statement-breakpoint
CREATE INDEX "contradictions_side_a_key_idx" ON "contradictions" USING btree ("side_a_key");--> statement-breakpoint
CREATE INDEX "contradictions_side_b_key_idx" ON "contradictions" USING btree ("side_b_key");--> statement-breakpoint
CREATE INDEX "evidence_items_project_id_seq_idx" ON "evidence_items" USING btree ("project_id","seq");--> statement-breakpoint
CREATE INDEX "evidence_items_snapshot_id_idx" ON "evidence_items" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "evidence_relations_project_id_seq_idx" ON "evidence_relations" USING btree ("project_id","seq");--> statement-breakpoint
CREATE INDEX "evidence_relations_evidence_id_idx" ON "evidence_relations" USING btree ("evidence_id");--> statement-breakpoint
CREATE INDEX "unknowns_project_id_seq_idx" ON "unknowns" USING btree ("project_id","seq");--> statement-breakpoint
CREATE INDEX "unknowns_claim_ids_idx" ON "unknowns" USING gin ("claim_ids");--> statement-breakpoint
CREATE INDEX "unknowns_evidence_ids_idx" ON "unknowns" USING gin ("evidence_ids");
