import { SLUG_PATTERN } from '@judge-copilot/schemas';
import { sql } from 'drizzle-orm';
import { check, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { sqlPattern, timestamptz } from './sql.js';

/** A hackathon. Event-specific rules live in versioned Event Context, never on this row. */
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    startsAt: timestamptz('starts_at'),
    endsAt: timestamptz('ends_at'),
    judgingStartsAt: timestamptz('judging_starts_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique('events_slug_key').on(table.slug),
    check('events_name_not_blank', sql`length(btrim(name)) > 0`),
    check('events_slug_format', sql`slug ~ ${sqlPattern(SLUG_PATTERN)}`),
    check(
      'events_ends_not_before_starts',
      sql`starts_at IS NULL OR ends_at IS NULL OR ends_at >= starts_at`,
    ),
  ],
);
