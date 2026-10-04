/*
 * Test-only helpers: open a migrated database. Excluded from the package build and exports.
 * PGlite always; real PostgreSQL only when TEST_DATABASE_URL names a disposable `*_test` database.
 */
import { PGlite } from '@electric-sql/pglite';
import { sql, type SQL } from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { expect } from 'vitest';
import { migrationsFolder, schema, type JudgeDatabase } from '../client.js';

export interface TestDatabase {
  db: JudgeDatabase;
  close: () => Promise<void>;
}

export async function openPglite(): Promise<TestDatabase> {
  const client = new PGlite();
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder });
  return { db, close: () => client.close() };
}

export async function openPostgres(url: string): Promise<TestDatabase> {
  const databaseName = new URL(url).pathname.slice(1);
  if (!databaseName.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must name a disposable database ending in "_test"');
  }
  const client = postgres(url, { max: 1, onnotice: () => undefined });
  await client.unsafe(
    'DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;',
  );
  const db = drizzlePostgres(client, { schema });
  await migratePostgres(db, { migrationsFolder });
  return { db, close: () => client.end() };
}

/** PGlite, plus real PostgreSQL when TEST_DATABASE_URL is set. */
export function testDatabaseTargets(): [string, () => Promise<TestDatabase>][] {
  const targets: [string, () => Promise<TestDatabase>][] = [['PGlite', openPglite]];
  const url = process.env['TEST_DATABASE_URL'];
  if (url) {
    targets.push(['PostgreSQL (TEST_DATABASE_URL)', () => openPostgres(url)]);
  }
  return targets;
}

export async function rows<T>(db: JudgeDatabase, query: SQL): Promise<T[]> {
  // postgres.js returns an array of rows; PGlite returns `{ rows }`.
  const result: unknown = await db.execute(query);
  return Array.isArray(result) ? (result as T[]) : (result as { rows: T[] }).rows;
}

export const SQLSTATE = {
  UNIQUE_VIOLATION: '23505',
  CHECK_VIOLATION: '23514',
  FOREIGN_KEY_VIOLATION: '23503',
  RESTRICT_VIOLATION: '23001',
} as const;

/** Asserts that a query fails with one of the given PostgreSQL SQLSTATEs (searching the cause chain). */
export async function expectPgError(
  operation: PromiseLike<unknown>,
  ...sqlStates: [string, ...string[]]
): Promise<void> {
  let error: unknown;
  try {
    await operation;
  } catch (caught) {
    error = caught;
  }
  const codes: unknown[] = [];
  for (let current = error; current instanceof Error; current = current.cause) {
    codes.push((current as { code?: unknown }).code);
  }
  expect(error, 'expected the query to be rejected').toBeInstanceOf(Error);
  expect(
    codes.some((code) => sqlStates.includes(code as string)),
    `expected SQLSTATE ${sqlStates.join(' or ')}, got ${codes.map(String).join(', ')}`,
  ).toBe(true);
}

export { sql };
