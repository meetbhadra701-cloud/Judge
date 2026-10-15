import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { getTableName, is, sql } from 'drizzle-orm';
import { migrationsFolder as migrationsFolderPath, type JudgeDatabase } from './client.js';
import { migrationHash, readJournal } from './migration-journal.js';
import * as tables from './schema/index.js';

/*
 * Post-migration verification (P6B-beta3-R2). The migrator reports success whenever its transaction commits; it cannot tell that a migration was
 * SKIPPED (see migration-journal.ts). These checks look at the database itself and are read-only SELECTs, safe against any database:
 *
 *   diagnoseMigrations   compares the migrator's own bookkeeping with the journal: which journal entries have no recorded run, and why that matters;
 *   verifySchemaObjects  checks that every table, column, named constraint (from the Drizzle schema), and every trigger and function the migration
 *                        SQL creates, actually exists.
 *
 * Neither repairs anything. A failure names what is missing; docs/MIGRATIONS.md §6 says what an operator does about it.
 */

export interface MigrationDiagnosis {
  /** Journal entries with no recorded application at all. */
  readonly notApplied: readonly string[];
  /** Entries not applied although a NEWER migration is recorded: the migrator will never apply them by itself (the skipped-migration signature). */
  readonly skipped: readonly string[];
  /** Entries applied under a different SQL text than the journal's current file (informational: the migrator never rechecks hashes). */
  readonly hashDiffers: readonly string[];
  /** Entries recorded more than once (a harmless re-application of an idempotent migration). */
  readonly appliedMoreThanOnce: readonly string[];
  readonly ok: boolean;
}

async function selectRows<T>(db: JudgeDatabase, query: ReturnType<typeof sql>): Promise<T[]> {
  const result: unknown = await db.execute(query);
  return Array.isArray(result) ? (result as T[]) : (result as { rows: T[] }).rows;
}

export async function diagnoseMigrations(
  db: JudgeDatabase,
  folder: string,
): Promise<MigrationDiagnosis> {
  const { entries } = readJournal(folder);
  const exists = await selectRows<{ present: string | null }>(
    db,
    sql`SELECT to_regclass('drizzle.__drizzle_migrations')::text AS present`,
  );
  const applied =
    exists[0]?.present == null
      ? []
      : await selectRows<{ hash: string; created_at: string }>(
          db,
          sql`SELECT hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
        );
  const newest = applied.reduce((max, row) => Math.max(max, Number(row.created_at)), -1);
  const notApplied: string[] = [];
  const skipped: string[] = [];
  const hashDiffers: string[] = [];
  const appliedMoreThanOnce: string[] = [];
  for (const entry of entries) {
    const byTime = applied.filter((row) => Number(row.created_at) === entry.when);
    const byHash = applied.filter((row) => row.hash === migrationHash(folder, entry.tag));
    if (byTime.length === 0 && byHash.length === 0) {
      notApplied.push(entry.tag);
      if (entry.when <= newest) skipped.push(entry.tag);
      continue;
    }
    if (byHash.length === 0) hashDiffers.push(entry.tag);
    if (Math.max(byTime.length, byHash.length) > 1) appliedMoreThanOnce.push(entry.tag);
  }
  return {
    notApplied,
    skipped,
    hashDiffers,
    appliedMoreThanOnce,
    ok: notApplied.length === 0,
  };
}

/** The triggers and functions the migration SQL creates, in journal order (a later DROP removes an earlier CREATE). */
export function expectedProgrammability(folder: string): {
  triggers: Map<string, string>;
  functions: Set<string>;
} {
  const triggers = new Map<string, string>();
  const functions = new Set<string>();
  for (const entry of readJournal(folder).entries) {
    const text = readFileSync(join(folder, `${entry.tag}.sql`), 'utf8');
    for (const statement of text.split('--> statement-breakpoint')) {
      const body = statement
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n');
      for (const m of body.matchAll(
        /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+"?([a-z0-9_]+)"?[\s\S]*?\sON\s+"?([a-z0-9_]+)"?/gi,
      )) {
        triggers.set(`${m[2] ?? ''}.${m[1] ?? ''}`, m[2] ?? '');
      }
      for (const m of body.matchAll(
        /DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"?([a-z0-9_]+)"?\s+ON\s+"?([a-z0-9_]+)"?/gi,
      )) {
        // a DROP followed by a CREATE of the same name (idempotent migrations) leaves the trigger expected
        triggers.delete(`${m[2] ?? ''}.${m[1] ?? ''}`);
      }
      for (const m of body.matchAll(
        /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"?([a-z0-9_]+)"?\s*\(/gi,
      )) {
        functions.add(m[1] ?? '');
      }
      for (const m of body.matchAll(/DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?"?([a-z0-9_]+)"?/gi)) {
        functions.delete(m[1] ?? '');
      }
    }
  }
  return { triggers, functions };
}

export interface SchemaVerification {
  readonly missing: readonly string[];
  readonly ok: boolean;
}

export async function verifySchemaObjects(
  db: JudgeDatabase,
  folder: string,
): Promise<SchemaVerification> {
  const missing: string[] = [];
  const have = async (query: ReturnType<typeof sql>, key: string): Promise<Set<string>> =>
    new Set((await selectRows<Record<string, string>>(db, query)).map((row) => row[key] ?? ''));
  const dbTables = await have(
    sql`SELECT table_name AS k FROM information_schema.tables WHERE table_schema = 'public'`,
    'k',
  );
  const dbColumns = await have(
    sql`SELECT table_name || '.' || column_name AS k FROM information_schema.columns WHERE table_schema = 'public'`,
    'k',
  );
  const dbConstraints = await have(
    sql`SELECT c.conname AS k FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'`,
    'k',
  );
  const dbIndexes = await have(
    sql`SELECT indexname AS k FROM pg_indexes WHERE schemaname = 'public'`,
    'k',
  );
  const dbTriggers = await have(
    sql`SELECT c.relname || '.' || t.tgname AS k FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname = 'public'`,
    'k',
  );
  const dbFunctions = await have(
    sql`SELECT p.proname AS k FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`,
    'k',
  );
  for (const candidate of Object.values(tables)) {
    if (!is(candidate, PgTable)) continue;
    const config = getTableConfig(candidate);
    const name = getTableName(candidate);
    if (!dbTables.has(name)) {
      missing.push(`table ${name}`);
      continue;
    }
    for (const column of config.columns) {
      if (!dbColumns.has(`${name}.${column.name}`)) missing.push(`column ${name}.${column.name}`);
    }
    const named = [
      ...config.checks.map((c) => c.name),
      ...config.foreignKeys.map((f) => f.getName()),
      ...config.uniqueConstraints.map((u) => u.name),
      ...config.primaryKeys.map((p) => p.getName()),
    ].filter((n): n is string => typeof n === 'string' && n.length > 0);
    for (const constraint of named) {
      if (!dbConstraints.has(constraint) && !dbIndexes.has(constraint)) {
        missing.push(`constraint ${name}.${constraint}`);
      }
    }
  }
  const expected = expectedProgrammability(folder);
  for (const key of expected.triggers.keys())
    if (!dbTriggers.has(key)) missing.push(`trigger ${key}`);
  for (const fn of expected.functions) if (!dbFunctions.has(fn)) missing.push(`function ${fn}`);
  return { missing: missing.sort(), ok: missing.length === 0 };
}

export class SchemaNotReadyError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `the database schema does not match this version of the software (${problems.join('; ')}). ` +
        'Do not start the service against it. See docs/MIGRATIONS.md section 6 (run `pnpm db:verify-schema` for the full report).',
    );
    this.name = 'SchemaNotReadyError';
  }
}

/**
 * Startup guard: refuses to run against a database whose migrations were skipped or whose objects are missing (read-only SELECTs). A migrator that
 * "succeeded" is not evidence that the schema is complete; this is.
 */
export async function assertSchemaReady(
  db: JudgeDatabase,
  folder: string = migrationsFolderPath,
): Promise<void> {
  const state = await diagnoseMigrations(db, folder);
  const objects = await verifySchemaObjects(db, folder);
  const problems = [
    ...state.notApplied.map((tag) => `migration ${tag} is not applied`),
    ...objects.missing.map((item) => `missing ${item}`),
  ];
  if (problems.length > 0) throw new SchemaNotReadyError(problems);
}
