import { sql, type SQL } from 'drizzle-orm';
import { timestamp } from 'drizzle-orm/pg-core';

/** All timestamps are stored as `timestamptz`. */
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

const SAFE_LITERAL = /^[a-z0-9_]+$/;

/**
 * Renders a SQL list of string literals for CHECK constraints from a shared vocabulary in
 * @judge-copilot/schemas, so database constraints and Zod schemas cannot drift apart.
 */
export function sqlLiteralList(values: readonly string[]): SQL {
  for (const value of values) {
    if (!SAFE_LITERAL.test(value)) {
      throw new Error(`Refusing to inline unsafe SQL literal: ${value}`);
    }
  }
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}

/** Renders a regex source as a SQL string literal. Patterns must not contain single quotes. */
export function sqlPattern(pattern: string): SQL {
  if (pattern.includes("'")) {
    throw new Error('Refusing to inline a regex pattern containing a single quote');
  }
  return sql.raw(`'${pattern}'`);
}
