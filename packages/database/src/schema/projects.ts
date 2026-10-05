import { SOURCE_INGESTION_LIMITS } from '@judge-copilot/schemas';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { actors } from './actors.js';
import { eventContextVersions } from './event-context-versions.js';
import { events } from './events.js';
import { timestamptz } from './sql.js';
import { tracks } from './tracks.js';

const L = SOURCE_INGESTION_LIMITS;

/**
 * A hackathon submission (M2). It belongs to exactly one event for its whole life (enforced by
 * trigger). Deliberately no score, evidence or AI-summary columns.
 */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    teamName: text('team_name'),
    createdByActorId: uuid('created_by_actor_id').references(() => actors.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('projects_event_id_name_key').on(table.eventId, table.name),
    // Target for composite references that pin a row to the same event.
    unique('projects_id_event_id_key').on(table.id, table.eventId),
    check(
      'projects_name_length',
      sql.raw(`length(btrim(name)) BETWEEN 1 AND ${String(L.projectNameMaxChars)}`),
    ),
    check(
      'projects_team_name_length',
      sql.raw(
        `team_name IS NULL OR length(btrim(team_name)) BETWEEN 1 AND ${String(L.teamNameMaxChars)}`,
      ),
    ),
  ],
);

/**
 * A project's declared track/prize, validated against the event's locked Event Context at
 * declaration time. The row keeps the exact version and track it was validated against, so a
 * later version superseding that context never rewrites the declaration. Immutable (trigger).
 * Metadata only: M2 never scores track alignment.
 */
export const projectTrackSelections = pgTable(
  'project_track_selections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull(),
    eventId: uuid('event_id').notNull(),
    contextVersionId: uuid('context_version_id').notNull(),
    trackId: uuid('track_id').notNull(),
    trackKey: text('track_key').notNull(),
    declaredByActorId: uuid('declared_by_actor_id').references(() => actors.id, {
      onDelete: 'restrict',
    }),
    declaredAt: timestamptz('declared_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'project_track_selections_project_same_event_fk',
      columns: [table.projectId, table.eventId],
      foreignColumns: [projects.id, projects.eventId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'project_track_selections_context_same_event_fk',
      columns: [table.contextVersionId, table.eventId],
      foreignColumns: [eventContextVersions.id, eventContextVersions.eventId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'project_track_selections_track_same_version_fk',
      columns: [table.trackId, table.contextVersionId],
      foreignColumns: [tracks.id, tracks.contextVersionId],
    }).onDelete('restrict'),
    unique('project_track_selections_project_id_track_id_key').on(table.projectId, table.trackId),
    unique('project_track_selections_project_version_key_key').on(
      table.projectId,
      table.contextVersionId,
      table.trackKey,
    ),
    index('project_track_selections_project_id_idx').on(table.projectId),
  ],
);
