import { IDENTIFIER_PATTERN } from '@judge-copilot/schemas';
import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { eventContextVersions } from './event-context-versions.js';
import { provenanceChecks, provenanceColumns } from './provenance.js';
import { sqlPattern, timestamptz } from './sql.js';

/** A prize track defined by an Event Context version. Frozen with its version. */
export const tracks = pgTable(
  'tracks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contextVersionId: uuid('context_version_id')
      .notNull()
      .references(() => eventContextVersions.id, { onDelete: 'restrict' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    displayOrder: integer('display_order').notNull(),
    ...provenanceColumns(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('tracks_context_version_id_key_key').on(table.contextVersionId, table.key),
    unique('tracks_context_version_id_display_order_key').on(
      table.contextVersionId,
      table.displayOrder,
    ),
    unique('tracks_id_context_version_id_key').on(table.id, table.contextVersionId),
    check('tracks_key_format', sql`key ~ ${sqlPattern(IDENTIFIER_PATTERN)}`),
    check('tracks_name_not_blank', sql`length(btrim(name)) > 0`),
    check('tracks_display_order_non_negative', sql`display_order >= 0`),
    ...provenanceChecks('tracks'),
  ],
);
