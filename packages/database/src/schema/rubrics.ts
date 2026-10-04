import { IDENTIFIER_PATTERN, RUBRIC_SCOPE_VALUES } from '@judge-copilot/schemas';
import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { eventContextVersions } from './event-context-versions.js';
import { provenanceChecks, provenanceColumns } from './provenance.js';
import { sqlLiteralList, sqlPattern, timestamptz } from './sql.js';
import { tracks } from './tracks.js';

/**
 * A rubric of an Event Context version: the overall rubric (at most one) or one per track.
 * Normalized so criteria, weights and anchors are queryable and constrained relationally.
 */
export const rubrics = pgTable(
  'rubrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contextVersionId: uuid('context_version_id')
      .notNull()
      .references(() => eventContextVersions.id, { onDelete: 'restrict' }),
    trackId: uuid('track_id'),
    name: text('name').notNull(),
    scope: text('scope', { enum: RUBRIC_SCOPE_VALUES }).notNull(),
    scaleMin: doublePrecision('scale_min').notNull(),
    scaleMax: doublePrecision('scale_max').notNull(),
    displayOrder: integer('display_order').notNull(),
    ...provenanceColumns(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    // A track rubric must belong to a track of the same context version.
    foreignKey({
      name: 'rubrics_track_same_version_fk',
      columns: [table.trackId, table.contextVersionId],
      foreignColumns: [tracks.id, tracks.contextVersionId],
    }).onDelete('restrict'),
    unique('rubrics_track_id_key').on(table.trackId),
    unique('rubrics_context_version_id_display_order_key').on(
      table.contextVersionId,
      table.displayOrder,
    ),
    uniqueIndex('rubrics_one_overall_per_version')
      .on(table.contextVersionId)
      .where(sql.raw(`scope = 'overall'`)),
    index('rubrics_context_version_id_idx').on(table.contextVersionId),
    check('rubrics_scope_valid', sql`scope IN (${sqlLiteralList(RUBRIC_SCOPE_VALUES)})`),
    check('rubrics_scope_matches_track', sql`(scope = 'overall') = (track_id IS NULL)`),
    check('rubrics_scale_valid', sql`scale_min < scale_max`),
    check('rubrics_name_not_blank', sql`length(btrim(name)) > 0`),
    ...provenanceChecks('rubrics'),
  ],
);

export const rubricCriteria = pgTable(
  'rubric_criteria',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rubricId: uuid('rubric_id')
      .notNull()
      .references(() => rubrics.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    /** Fraction in (0, 1]; null when the official rubric gives no weights. */
    weight: doublePrecision('weight'),
    displayOrder: integer('display_order').notNull(),
    ...provenanceColumns(),
  },
  (table) => [
    unique('rubric_criteria_rubric_id_key_key').on(table.rubricId, table.key),
    unique('rubric_criteria_rubric_id_display_order_key').on(table.rubricId, table.displayOrder),
    check('rubric_criteria_key_format', sql`key ~ ${sqlPattern(IDENTIFIER_PATTERN)}`),
    check('rubric_criteria_weight_range', sql`weight IS NULL OR (weight > 0 AND weight <= 1)`),
    ...provenanceChecks('rubric_criteria'),
  ],
);

export const rubricAnchors = pgTable(
  'rubric_anchors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    criterionId: uuid('criterion_id')
      .notNull()
      .references(() => rubricCriteria.id, { onDelete: 'cascade' }),
    score: doublePrecision('score').notNull(),
    description: text('description').notNull(),
  },
  (table) => [
    unique('rubric_anchors_criterion_id_score_key').on(table.criterionId, table.score),
    check('rubric_anchors_description_not_blank', sql`length(btrim(description)) > 0`),
  ],
);
