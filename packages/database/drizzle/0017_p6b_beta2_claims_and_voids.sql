CREATE TABLE "project_replacements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"voided_project_id" uuid NOT NULL,
	"replacement_project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_replacements_voided_key" UNIQUE("voided_project_id"),
	CONSTRAINT "project_replacements_replacement_key" UNIQUE("replacement_project_id"),
	CONSTRAINT "project_replacements_distinct" CHECK (voided_project_id <> replacement_project_id)
);
--> statement-breakpoint
CREATE TABLE "project_submission_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_submission_claims_event_kind_value_key" UNIQUE("event_id","kind","value"),
	CONSTRAINT "project_submission_claims_kind" CHECK (kind IN ('github', 'devpost', 'name')),
	CONSTRAINT "project_submission_claims_value" CHECK (length(value) > 0)
);
--> statement-breakpoint
CREATE TABLE "project_voids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"voided_by_actor_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"name_before" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_voids_project_id_key" UNIQUE("project_id"),
	CONSTRAINT "project_voids_actor_key_key" UNIQUE("voided_by_actor_id","idempotency_key"),
	CONSTRAINT "project_voids_reason" CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
	CONSTRAINT "project_voids_key_format" CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
	CONSTRAINT "project_voids_hash_hex" CHECK (request_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "project_submissions" DROP CONSTRAINT "project_submissions_event_github_key";--> statement-breakpoint
ALTER TABLE "project_submissions" DROP CONSTRAINT "project_submissions_event_devpost_key";--> statement-breakpoint
ALTER TABLE "project_submissions" DROP CONSTRAINT "project_submissions_event_name_key";--> statement-breakpoint
ALTER TABLE "project_submissions" DROP CONSTRAINT "project_submissions_github_url";--> statement-breakpoint
ALTER TABLE "project_submissions" DROP CONSTRAINT "project_submissions_devpost_url";--> statement-breakpoint
ALTER TABLE "project_replacements" ADD CONSTRAINT "project_replacements_voided_fk" FOREIGN KEY ("voided_project_id","event_id") REFERENCES "public"."projects"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_replacements" ADD CONSTRAINT "project_replacements_replacement_fk" FOREIGN KEY ("replacement_project_id","event_id") REFERENCES "public"."projects"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_replacements" ADD CONSTRAINT "project_replacements_void_record_fk" FOREIGN KEY ("voided_project_id") REFERENCES "public"."project_voids"("project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_submission_claims" ADD CONSTRAINT "project_submission_claims_project_same_event_fk" FOREIGN KEY ("project_id","event_id") REFERENCES "public"."projects"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_voids" ADD CONSTRAINT "project_voids_voided_by_actor_id_actors_id_fk" FOREIGN KEY ("voided_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_voids" ADD CONSTRAINT "project_voids_project_same_event_fk" FOREIGN KEY ("project_id","event_id") REFERENCES "public"."projects"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_submission_claims_project_id_idx" ON "project_submission_claims" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "project_submissions" ADD CONSTRAINT "project_submissions_github_url" CHECK (github_url ~ '^https://github\.com/[a-z0-9._-]+/[a-z0-9._-]+$' AND github_url !~ '\.git$') NOT VALID;--> statement-breakpoint
ALTER TABLE "project_submissions" ADD CONSTRAINT "project_submissions_devpost_url" CHECK (devpost_url ~ '^https://devpost\.com/software/[a-z0-9]+(-[a-z0-9]+)*$') NOT VALID;