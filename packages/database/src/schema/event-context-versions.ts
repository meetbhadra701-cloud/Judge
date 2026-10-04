import {
  FROZEN_EVENT_CONTEXT_STATUSES,
  OFFICIAL_EVENT_CONTEXT_STATUS,
} from '@judge-copilot/domain';
import { EVENT_CONTEXT_STATUS_VALUES } from '@judge-copilot/schemas';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { events } from './events.js';
import { sqlLiteralList, timestamptz } from './sql.js';

/**
 * A version of an event's official context (rules, rubric, prizes/tracks, constraints).
 *
 * Versions are append-only: a change produces a new version that `supersedes` an older one of
 * the same event. Only a human-reviewed `locked` version may back an official assessment.
 * The structured context content itself is introduced in M1.
 */
export const eventContextVersions = pgTable(
  'event_context_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    status: text('status', { enum: EVENT_CONTEXT_STATUS_VALUES }).notNull(),
    summary: text('summary'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    lockedAt: timestamptz('locked_at'),
    supersedesId: uuid('supersedes_id'),
    changeReason: text('change_reason'),
  },
  (table) => [
    unique('event_context_versions_event_id_version_key').on(table.eventId, table.version),
    // Target for the composite foreign key below.
    unique('event_context_versions_id_event_id_key').on(table.id, table.eventId),
    // A version may only supersede another version of the same event.
    foreignKey({
      name: 'event_context_versions_supersedes_same_event_fk',
      columns: [table.supersedesId, table.eventId],
      foreignColumns: [table.id, table.eventId],
    }).onDelete('restrict'),
    // At most one current locked version per event.
    uniqueIndex('event_context_versions_one_locked_per_event')
      .on(table.eventId)
      .where(sql.raw(`status = '${OFFICIAL_EVENT_CONTEXT_STATUS}'`)),
    index('event_context_versions_supersedes_id_idx').on(table.supersedesId),
    check('event_context_versions_version_positive', sql`version >= 1`),
    check(
      'event_context_versions_status_valid',
      sql`status IN (${sqlLiteralList(EVENT_CONTEXT_STATUS_VALUES)})`,
    ),
    check(
      'event_context_versions_locked_at_matches_status',
      sql`(status IN (${sqlLiteralList(FROZEN_EVENT_CONTEXT_STATUSES)})) = (locked_at IS NOT NULL)`,
    ),
    check(
      'event_context_versions_not_self_superseding',
      sql`supersedes_id IS NULL OR supersedes_id <> id`,
    ),
  ],
);
