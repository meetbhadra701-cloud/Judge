import { PROJECT_SOURCE_TYPE_VALUES, SOURCE_INGESTION_LIMITS } from '@judge-copilot/schemas';
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { actors } from './actors.js';
import { projects } from './projects.js';
import { sqlLiteralList, timestamptz } from './sql.js';

/**
 * A declared project source (Devpost page, GitHub repository, deployment or video URL). A
 * declaration is not a snapshot: one source may have many snapshots. Rows are immutable
 * (trigger); a replacement URL is a new declaration. Identical declarations are rejected.
 */
export const projectSources = pgTable(
  'project_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    sourceType: text('source_type', { enum: PROJECT_SOURCE_TYPE_VALUES }).notNull(),
    /** Normalized declared URL (untrusted). */
    url: text('url').notNull(),
    position: integer('position').notNull(),
    createdByActorId: uuid('created_by_actor_id').references(() => actors.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('project_sources_project_type_url_key').on(table.projectId, table.sourceType, table.url),
    unique('project_sources_project_id_position_key').on(table.projectId, table.position),
    // Target for snapshots: their project, source type and URL must agree with the declaration.
    unique('project_sources_identity_key').on(
      table.id,
      table.projectId,
      table.sourceType,
      table.url,
    ),
    index('project_sources_project_id_idx').on(table.projectId),
    check(
      'project_sources_source_type_valid',
      sql`source_type IN (${sqlLiteralList(PROJECT_SOURCE_TYPE_VALUES)})`,
    ),
    check(
      'project_sources_url_format',
      sql.raw(
        `url ~ '^https?://[^[:space:]]+$' AND length(url) <= ${String(SOURCE_INGESTION_LIMITS.urlMaxChars)}`,
      ),
    ),
    check('project_sources_position_non_negative', sql`position >= 0`),
  ],
);
