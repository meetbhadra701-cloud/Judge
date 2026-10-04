import {
  EVENT_CONTEXT_LIMITS,
  EVENT_SOURCE_AUTHORITY_VALUES,
  EVENT_SOURCE_TYPE_VALUES,
} from '@judge-copilot/schemas';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { eventContextVersions } from './event-context-versions.js';
import { sqlLiteralList, timestamptz } from './sql.js';

/**
 * Source material for one Event Context version: normalized, untrusted text plus its authority
 * and SHA-256 content hash. Rows are immutable (UPDATE is always rejected by trigger) and cannot
 * be added or removed once the owning version is frozen. A new version copies its base
 * version's sources (`copied_from_id`) instead of sharing them.
 */
export const eventSources = pgTable(
  'event_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contextVersionId: uuid('context_version_id')
      .notNull()
      .references(() => eventContextVersions.id, { onDelete: 'restrict' }),
    sourceType: text('source_type', { enum: EVENT_SOURCE_TYPE_VALUES }).notNull(),
    authority: text('authority', { enum: EVENT_SOURCE_AUTHORITY_VALUES }).notNull(),
    title: text('title').notNull(),
    url: text('url'),
    normalizedText: text('normalized_text').notNull(),
    contentHash: text('content_hash').notNull(),
    capturedAt: timestamptz('captured_at').notNull().defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /** 0-based order within the version; copies keep their original position. */
    position: integer('position').notNull(),
    copiedFromId: uuid('copied_from_id').references((): AnyPgColumn => eventSources.id, {
      onDelete: 'restrict',
    }),
  },
  (table) => [
    // Target for composite references that pin a row to the same context version.
    unique('event_sources_id_context_version_id_key').on(table.id, table.contextVersionId),
    unique('event_sources_context_version_id_position_key').on(
      table.contextVersionId,
      table.position,
    ),
    index('event_sources_context_version_id_idx').on(table.contextVersionId),
    check(
      'event_sources_source_type_valid',
      sql`source_type IN (${sqlLiteralList(EVENT_SOURCE_TYPE_VALUES)})`,
    ),
    check(
      'event_sources_authority_valid',
      sql`authority IN (${sqlLiteralList(EVENT_SOURCE_AUTHORITY_VALUES)})`,
    ),
    check(
      'event_sources_title_length',
      sql.raw(
        `length(btrim(title)) BETWEEN 1 AND ${String(EVENT_CONTEXT_LIMITS.sourceTitleMaxChars)}`,
      ),
    ),
    check(
      'event_sources_url_format',
      sql.raw(
        `url IS NULL OR (url ~ '^https?://' AND length(url) <= ${String(EVENT_CONTEXT_LIMITS.urlMaxChars)})`,
      ),
    ),
    check('event_sources_url_text_requires_url', sql`source_type <> 'url_text' OR url IS NOT NULL`),
    check(
      'event_sources_text_length',
      sql.raw(
        `length(normalized_text) BETWEEN 1 AND ${String(EVENT_CONTEXT_LIMITS.sourceTextMaxChars)}`,
      ),
    ),
    check('event_sources_content_hash_format', sql`content_hash ~ '^[0-9a-f]{64}$'`),
    check('event_sources_position_non_negative', sql`position >= 0`),
  ],
);
