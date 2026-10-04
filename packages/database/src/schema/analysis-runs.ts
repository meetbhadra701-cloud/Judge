import {
  ANALYSIS_RUN_FAILURE_CATEGORY_VALUES,
  ANALYSIS_RUN_STATE_VALUES,
  IDENTIFIER_PATTERN,
} from '@judge-copilot/schemas';
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { events } from './events.js';
import { sqlLiteralList, sqlPattern, timestamptz } from './sql.js';

/**
 * One execution of a pipeline stage. `run_type` is a snake_case identifier registered by the
 * milestone that introduces the stage (none exist in M0). A failed run records a failure
 * category and never produces a score (invariant 22).
 *
 * `project_id` is intentionally absent until projects exist (M2); it will be added by migration.
 */
export const analysisRuns = pgTable(
  'analysis_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'restrict' }),
    runType: text('run_type').notNull(),
    state: text('state', { enum: ANALYSIS_RUN_STATE_VALUES }).notNull(),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    finishedAt: timestamptz('finished_at'),
    failureCategory: text('failure_category', { enum: ANALYSIS_RUN_FAILURE_CATEGORY_VALUES }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('analysis_runs_event_id_idx').on(table.eventId),
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
      sql`(state = 'running') = (finished_at IS NULL)`,
    ),
    check(
      'analysis_runs_failure_category_matches_state',
      sql`(state = 'failed') = (failure_category IS NOT NULL)`,
    ),
    check(
      'analysis_runs_finished_not_before_started',
      sql`finished_at IS NULL OR finished_at >= started_at`,
    ),
  ],
);
