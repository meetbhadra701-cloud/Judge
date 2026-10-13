CREATE TABLE "project_submission_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"submission_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"result" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_submission_requests_actor_key_key" UNIQUE("actor_id","idempotency_key"),
	CONSTRAINT "project_submission_requests_key_format" CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
	CONSTRAINT "project_submission_requests_hash_hex" CHECK (request_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "project_submission_requests_result" CHECK (result IN ('created', 'already_submitted'))
);
--> statement-breakpoint
CREATE TABLE "project_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"submitted_by_actor_id" uuid NOT NULL,
	"github_url" text NOT NULL,
	"devpost_url" text NOT NULL,
	"name_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_submissions_project_id_key" UNIQUE("project_id"),
	CONSTRAINT "project_submissions_event_github_key" UNIQUE("event_id","github_url"),
	CONSTRAINT "project_submissions_event_devpost_key" UNIQUE("event_id","devpost_url"),
	CONSTRAINT "project_submissions_event_name_key" UNIQUE("event_id","name_key"),
	CONSTRAINT "project_submissions_id_project_id_key" UNIQUE("id","project_id"),
	CONSTRAINT "project_submissions_github_url" CHECK (github_url ~ '^https://github\.com/[^/[:space:]]+/[^/[:space:]]+$'),
	CONSTRAINT "project_submissions_devpost_url" CHECK (devpost_url ~ '^https://devpost\.com/software/[^/[:space:]]+$'),
	CONSTRAINT "project_submissions_name_key" CHECK (length(name_key) > 0 AND name_key = btrim(name_key))
);
--> statement-breakpoint
ALTER TABLE "project_submission_requests" ADD CONSTRAINT "project_submission_requests_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_submission_requests" ADD CONSTRAINT "project_submission_requests_submission_fk" FOREIGN KEY ("submission_id","project_id") REFERENCES "public"."project_submissions"("id","project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_submissions" ADD CONSTRAINT "project_submissions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_submissions" ADD CONSTRAINT "project_submissions_submitted_by_actor_id_actors_id_fk" FOREIGN KEY ("submitted_by_actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_submissions" ADD CONSTRAINT "project_submissions_project_same_event_fk" FOREIGN KEY ("project_id","event_id") REFERENCES "public"."projects"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_submission_requests_submission_id_idx" ON "project_submission_requests" USING btree ("submission_id");