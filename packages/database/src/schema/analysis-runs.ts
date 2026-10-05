import { ACTIVE_ANALYSIS_RUN_STATES } from '@judge-copilot/domain';
import {
  ANALYSIS_RUN_FAILURE_CATEGORY_VALUES,
  ANALYSIS_RUN_STATE_VALUES,
  IDENTIFIER_PATTERN,
} from '@judge-copilot/schemas';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { eventContextVersions } from './event-context-versions.js';
import { events } from './events.js';
import { projects } from './projects.js';
import { sourceSnapshots } from './source-snapshots.js';
import { sqlLiteralList, sqlPattern, timestamptz } from './sql.js';

/**
 * One execution of a pipeline stage. `run_type` is a snake_case identifier registered by the
 * milestone that introduces the stage (none exist in M0). A failed run records a failure
 * category and never produces a score (invariant 22).
 *
 * `context_version_id` (M1) links Event Context builds (`run_type = event_context_build`) to the
 * version they built.
 *
 * M2: `project_id` and `source_snapshot_id` link source captures (`run_type =
 * project_source_capture`, exactly one run per snapshot). A capture run is created `pending` (queued
 * work, `started_at` null) and claimed by a worker with a lease (`lease_token`,
 * `lease_expires_at`); `attempt_count` counts adapter attempts (at most one retry).
 */
export const analysisRuns = pgTable(
  'analysis_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'restrict' }),
    contextVersionId: uuid('context_version_id').references(() => eventContextVersions.id, {
      onDelete: 'restrict',
    }),
    runType: text('run_type').notNull(),
    state: text('state', { enum: ANALYSIS_RUN_STATE_VALUES }).notNull(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'restrict' }),
    sourceSnapshotId: uuid('source_snapshot_id').references(() => sourceSnapshots.id, {
      onDelete: 'restrict',
    }),
    startedAt: timestamptz('started_at').defaultNow(),
    leaseToken: uuid('lease_token'),
    leaseExpiresAt: timestamptz('lease_expires_at'),
    attemptCount: integer('attempt_count').notNull().default(0),
    finishedAt: timestamptz('finished_at'),
    failureCategory: text('failure_category', { enum: ANALYSIS_RUN_FAILURE_CATEGORY_VALUES }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('analysis_runs_event_id_idx').on(table.eventId),
    index('analysis_runs_context_version_id_idx').on(table.contextVersionId),
    index('analysis_runs_project_id_idx').on(table.projectId),
    index('analysis_runs_state_run_type_idx').on(table.state, table.runType),
    unique('analysis_runs_source_snapshot_id_key').on(table.sourceSnapshotId),
    foreignKey({
      name: 'analysis_runs_snapshot_same_project_fk',
      columns: [table.sourceSnapshotId, table.projectId],
      foreignColumns: [sourceSnapshots.id, sourceSnapshots.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'analysis_runs_project_same_event_fk',
      columns: [table.projectId, table.eventId],
      foreignColumns: [projects.id, projects.eventId],
    }).onDelete('restrict'),
    check('analysis_runs_run_type_format', sql`run_type ~ ${sqlPattern(IDENTIFIER_PATTERN)}`),
    check(
      'analysis_runs_state_valid',
      sql`state IN (${sqlLiteralList(ANALYSIS_RUN_STATE_VALUES)})`,
    ),
    check(
      'analysis_runs_failure_category_valid',
      sql`failure_category IS NULL OR failure_category IN (${sqlLiteralList(ANALYSIS_RUN_FAILURE_CATEGORY_VALUES)})`,
    ),
    check(
      'analysis_runs_finished_at_matches_state',
      sql`(state IN (${sqlLiteralList(ACTIVE_ANALYSIS_RUN_STATES)})) = (finished_at IS NULL)`,
    ),
    check(
      'analysis_runs_failure_category_matches_state',
      sql`(state = 'failed') = (failure_category IS NOT NULL)`,
    ),
    check(
      'analysis_runs_started_at_matches_state',
      sql`(state = 'pending') = (started_at IS NULL)`,
    ),
    check(
      'analysis_runs_pending_has_no_lease',
      sql`state <> 'pending' OR (lease_token IS NULL AND lease_expires_at IS NULL)`,
    ),
    check('analysis_runs_attempt_count_non_negative', sql`attempt_count >= 0`),
    check(
      'analysis_runs_capture_links',
      sql`run_type <> 'project_source_capture' OR (event_id IS NOT NULL AND project_id IS NOT NULL AND source_snapshot_id IS NOT NULL)`,
    ),
    check(
      'analysis_runs_finished_not_before_started',
      sql`finished_at IS NULL OR finished_at >= started_at`,
    ),
  ],
);
