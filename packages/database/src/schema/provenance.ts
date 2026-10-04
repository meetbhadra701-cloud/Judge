import { FACT_ORIGIN_VALUES } from '@judge-copilot/schemas';
import { sql } from 'drizzle-orm';
import { boolean, check, text, uuid } from 'drizzle-orm/pg-core';
import { sqlLiteralList } from './sql.js';

/**
 * Provenance columns shared by normalized Event Context structure (tracks, rubrics, criteria).
 * `source_ids` must reference sources of the same context version (enforced by trigger).
 */
export const provenanceColumns = () => ({
  sourceIds: uuid('source_ids')
    .array()
    .notNull()
    .default(sql`'{}'::uuid[]`),
  origin: text('origin', { enum: FACT_ORIGIN_VALUES }).notNull(),
  humanModified: boolean('human_modified').notNull().default(false),
});

export const provenanceChecks = (table: string) => [
  check(`${table}_origin_valid`, sql`origin IN (${sqlLiteralList(FACT_ORIGIN_VALUES)})`),
];
