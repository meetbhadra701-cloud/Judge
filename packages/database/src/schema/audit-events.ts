import { DOTTED_IDENTIFIER_PATTERN, IDENTIFIER_PATTERN } from '@judge-copilot/schemas';
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { sqlPattern, timestamptz } from './sql.js';

/**
 * Append-only audit trail. UPDATE, DELETE and TRUNCATE are rejected by a trigger
 * (migration 0001_audit_events_append_only). `actor_id` is null for system actions; it gains a
 * foreign key when authentication is introduced. `entity_id` is polymorphic and therefore has
 * no foreign key.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id'),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    action: text('action').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('audit_events_entity_idx').on(table.entityType, table.entityId, table.createdAt),
    check('audit_events_entity_type_format', sql`entity_type ~ ${sqlPattern(IDENTIFIER_PATTERN)}`),
    check('audit_events_action_format', sql`action ~ ${sqlPattern(DOTTED_IDENTIFIER_PATTERN)}`),
    check('audit_events_metadata_is_object', sql`jsonb_typeof(metadata) = 'object'`),
  ],
);
