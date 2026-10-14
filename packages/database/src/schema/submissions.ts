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
 *   - one ACTIVE project per (event, GitHub URL), per (event, Devpost URL) and per (event, case-folded name): the ownership of a link or a
 *     label lives in `project_submission_claims` (unique per event), written by a trigger when a submission is recorded and released only when the
 *     project is VOIDED (`project_voids`, P6B-beta2). A voided project keeps every row it ever had; only its claim on the identity is released,
 *     so a corrected submission can take the links without any history being rewritten;
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
    /**
     * `lower(btrim(project name))`, DERIVED BY THE DATABASE from the project row (a trigger overwrites whatever an application supplies), so the
     * label identity cannot disagree with the SQL comparisons made elsewhere. Names that differ only by case are the same label.
     */
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
    // Target for the request records: they point at a submission of the same project.
    unique('project_submissions_id_project_id_key').on(table.id, table.projectId),
    check(
      'project_submissions_github_url',
      sql`github_url ~ '^https://github\\.com/[a-z0-9._-]+/[a-z0-9._-]+$' AND github_url !~ '\\.git$'`,
    ),
    check(
      'project_submissions_devpost_url',
      sql`devpost_url ~ '^https://devpost\\.com/software/[a-z0-9]+(-[a-z0-9]+)*$'`,
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

// -- Ownership of a submission's identity, and its explicit release (P6B-beta2) ----------------------------------------------

export const SUBMISSION_CLAIM_KIND_VALUES = ['github', 'devpost', 'name'] as const;

/**
 * Who currently owns a GitHub URL, a Devpost URL or a case-folded name within an event. One row per (event, kind, value): the unique constraint is
 * what makes two active submissions unable to share a link or a label. Rows are written by a trigger when a submission is recorded, can never be
 * updated, and can be deleted only after the project has been voided (the delete trigger requires the void record), which is how a corrected
 * submission is allowed to take the links of an erroneous one while the erroneous project and everything captured for it stay as they were.
 */
export const projectSubmissionClaims = pgTable(
  'project_submission_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id').notNull(),
    projectId: uuid('project_id').notNull(),
    kind: text('kind', { enum: SUBMISSION_CLAIM_KIND_VALUES }).notNull(),
    value: text('value').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'project_submission_claims_project_same_event_fk',
      columns: [table.projectId, table.eventId],
      foreignColumns: [projects.id, projects.eventId],
    }).onDelete('restrict'),
    unique('project_submission_claims_event_kind_value_key').on(
      table.eventId,
      table.kind,
      table.value,
    ),
    index('project_submission_claims_project_id_idx').on(table.projectId),
    check(
      'project_submission_claims_kind',
      sql`kind IN (${sqlLiteralList(SUBMISSION_CLAIM_KIND_VALUES)})`,
    ),
    check('project_submission_claims_value', sql`length(value) > 0`),
  ],
);

/**
 * The explicit, immutable correction of a project: an authorized organizer declared it erroneous. The project, its sources, snapshots,
 * extractions, assessments and reports are NOT touched (so every historical report stays reproducible); what changes is that the project can no
 * longer start captures or assessments, its claims on links and name are released, and its label is marked. At most one void per project.
 */
export const projectVoids = pgTable(
  'project_voids',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id').notNull(),
    projectId: uuid('project_id').notNull(),
    voidedByActorId: uuid('voided_by_actor_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'restrict' }),
    reason: text('reason').notNull(),
    /** The project's name before the label was marked (the label is the only thing about the project that changes). */
    nameBefore: text('name_before').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'project_voids_project_same_event_fk',
      columns: [table.projectId, table.eventId],
      foreignColumns: [projects.id, projects.eventId],
    }).onDelete('restrict'),
    unique('project_voids_project_id_key').on(table.projectId),
    unique('project_voids_actor_key_key').on(table.voidedByActorId, table.idempotencyKey),
    check('project_voids_reason', sql`length(btrim(reason)) BETWEEN 1 AND 1000`),
    check('project_voids_key_format', sql`idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'`),
    check('project_voids_hash_hex', sql`request_hash ~ ${HEX64}`),
  ],
);

/** Which project replaced a voided one (optional metadata of a correction made in one operation). Append-only. */
export const projectReplacements = pgTable(
  'project_replacements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id').notNull(),
    voidedProjectId: uuid('voided_project_id').notNull(),
    replacementProjectId: uuid('replacement_project_id').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'project_replacements_voided_fk',
      columns: [table.voidedProjectId, table.eventId],
      foreignColumns: [projects.id, projects.eventId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'project_replacements_replacement_fk',
      columns: [table.replacementProjectId, table.eventId],
      foreignColumns: [projects.id, projects.eventId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'project_replacements_void_record_fk',
      columns: [table.voidedProjectId],
      foreignColumns: [projectVoids.projectId],
    }).onDelete('restrict'),
    unique('project_replacements_voided_key').on(table.voidedProjectId),
    unique('project_replacements_replacement_key').on(table.replacementProjectId),
    check('project_replacements_distinct', sql`voided_project_id <> replacement_project_id`),
  ],
);
