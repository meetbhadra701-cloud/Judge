import { SOURCE_INGESTION_LIMITS } from '@judge-copilot/schemas';
import { sql } from 'drizzle-orm';
import { check, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './sql.js';

/**
 * Authenticated identities seen by the API (M2). An actor is the pair (issuer, subject) a verified
 * credential carried; no credential, password or token is ever stored. Rows are immutable and
 * referenced by audit events and by the records an actor created.
 */
export const actors = pgTable(
  'actors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('actors_issuer_subject_key').on(table.issuer, table.subject),
    check(
      'actors_issuer_length',
      sql.raw(
        `length(issuer) BETWEEN 1 AND ${String(SOURCE_INGESTION_LIMITS.actorIssuerMaxChars)}`,
      ),
    ),
    check(
      'actors_subject_length',
      sql.raw(
        `length(subject) BETWEEN 1 AND ${String(SOURCE_INGESTION_LIMITS.actorSubjectMaxChars)}`,
      ),
    ),
  ],
);
