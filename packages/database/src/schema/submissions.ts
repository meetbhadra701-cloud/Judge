import { SUBMISSION_RECORDED_RESULT_VALUES } from '@judge-copilot/schemas';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { actors } from './actors.js';
import { events } from './events.js';
import { projects } from './projects.js';
import { sqlLiteralList, timestamptz } from './sql.js';

/*
 * P6B-beta1: submission intents. A submission is ONE logical intent -- one GitHub repository plus one Devpost page for one event -- and it
 * owns exactly one project. Both tables are append-only (migration 0016 adds the triggers). The database, not the application, enforces:
 *
 *   - one project per (event, GitHub URL), per (event, Devpost URL) and per (event, case-folded name): two different submissions can
 *     never share a link or a label, whatever the interleaving of their requests;
 *   - one idempotency record per (actor, key); the request hash pins the content that key was first used for;
 *   - a project that has a submission never gains a different GitHub or Devpost source (trigger on project_sources).
 */

const HEX64 = sql.raw(`'^[0-9a-f]{64}$'`);

export const projectSubmissions = pgTable(
  'project_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id').notNull(),
    submittedByActorId: uuid('submitted_by_actor_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'restrict' }),
    /** Canonical (lowercase) declared URLs: the identity of the intent. */
    githubUrl: text('github_url').notNull(),
    devpostUrl: text('devpost_url').notNull(),
    /** The trimmed, lower-cased project name at creation: names that differ only by case are the same label. */
    nameKey: text('name_key').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'project_submissions_project_same_event_fk',
      columns: [table.projectId, table.eventId],
      foreignColumns: [projects.id, projects.eventId],
    }).onDelete('restrict'),
    unique('project_submissions_project_id_key').on(table.projectId),
    unique('project_submissions_event_github_key').on(table.eventId, table.githubUrl),
    unique('project_submissions_event_devpost_key').on(table.eventId, table.devpostUrl),
    unique('project_submissions_event_name_key').on(table.eventId, table.nameKey),
    // Target for the request records: they point at a submission of the same project.
    unique('project_submissions_id_project_id_key').on(table.id, table.projectId),
    check(
      'project_submissions_github_url',
      sql`github_url ~ '^https://github\\.com/[^/[:space:]]+/[^/[:space:]]+$'`,
    ),
    check(
      'project_submissions_devpost_url',
      sql`devpost_url ~ '^https://devpost\\.com/software/[^/[:space:]]+$'`,
    ),
    check('project_submissions_name_key', sql`length(name_key) > 0 AND name_key = btrim(name_key)`),
  ],
);

/**
 * One idempotent submission request: the first use of an `Idempotency-Key` by an actor. `request_hash` pins the content (event, links,
 * typed name); the same key with different content is refused, never silently mapped to the first result.
 */
export const projectSubmissionRequests = pgTable(
  'project_submission_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'restrict' }),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    submissionId: uuid('submission_id').notNull(),
    projectId: uuid('project_id').notNull(),
    /** What this request did: `created` the project, or `already_submitted` (converged on an identical earlier submission). */
    result: text('result', { enum: SUBMISSION_RECORDED_RESULT_VALUES }).notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'project_submission_requests_submission_fk',
      columns: [table.submissionId, table.projectId],
      foreignColumns: [projectSubmissions.id, projectSubmissions.projectId],
    }).onDelete('restrict'),
    unique('project_submission_requests_actor_key_key').on(table.actorId, table.idempotencyKey),
    index('project_submission_requests_submission_id_idx').on(table.submissionId),
    check(
      'project_submission_requests_key_format',
      sql`idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'`,
    ),
    check('project_submission_requests_hash_hex', sql`request_hash ~ ${HEX64}`),
    check(
      'project_submission_requests_result',
      sql`result IN (${sqlLiteralList(SUBMISSION_RECORDED_RESULT_VALUES)})`,
    ),
  ],
);
