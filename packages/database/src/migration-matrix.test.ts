import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrationsFolder } from './client.js';
import { checkMigrationJournal } from './migration-journal.js';
import {
  assertSchemaReady,
  diagnoseMigrations,
  SchemaNotReadyError,
  verifySchemaObjects,
} from './schema-state.js';
import {
  emptyDatabaseTargets,
  migrateFolder,
  rows,
  sql,
  type TestDatabase,
} from './testing/databases.js';

/*
 * P6B-beta3-R2 (P1): the upgrade matrix, run with the REAL migrators on PGlite and, when TEST_DATABASE_URL is set, PostgreSQL. Exit codes are
 * never the evidence: after each path the schema objects themselves are checked (verifySchemaObjects reads pg_catalog), and the migrator's own
 * bookkeeping is compared with the journal (diagnoseMigrations).
 *
 * The folder shipped in the R1 branch (cb9c7a1) is reconstructed here as `r1Folder`: the same files except that migration 0020 has its original
 * (too old) timestamp and its original, non-idempotent SQL. That is the folder the R7E reviewer ran.
 */

const R1_WHEN_0020 = 1792054780003;
const FINAL = 20;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function copyFolder(): { root: string; journalPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'judge-matrix-'));
  cpSync(migrationsFolder, root, { recursive: true });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, journalPath: join(root, 'meta', '_journal.json') };
}
interface JournalFile {
  entries: { idx: number; when: number; tag: string; version: string; breakpoints: boolean }[];
}
function folderUpTo(last: number): string {
  const { root, journalPath } = copyFolder();
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as JournalFile;
  journal.entries = journal.entries.filter((entry) => entry.idx <= last);
  writeFileSync(journalPath, JSON.stringify(journal));
  return root;
}
/** The journal and migration 0020 exactly as the R1 branch shipped them (the migrator skips 0020 on a database that applied 0019). */
function r1Folder(): string {
  const { root, journalPath } = copyFolder();
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as JournalFile;
  const entry = journal.entries.find((candidate) => candidate.idx === FINAL);
  if (!entry) throw new Error('no 0020 entry');
  entry.when = R1_WHEN_0020;
  writeFileSync(journalPath, JSON.stringify(journal));
  writeFileSync(
    join(root, `${entry.tag}.sql`),
    readFileSync(new URL('./testing/legacy-0020-r1.sql', import.meta.url), 'utf8'),
  );
  return root;
}

/** A fingerprint of the coverage table's constraints, triggers and guard function, as the catalog defines them. */
async function coverageFingerprint(db: TestDatabase['db']): Promise<string[]> {
  const constraints = await rows<{ d: string }>(
    db,
    sql`SELECT conname || ' ' || pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'public.assessment_run_coverage'::regclass ORDER BY 1`,
  );
  const triggers = await rows<{ d: string }>(
    db,
    sql`SELECT pg_get_triggerdef(oid) AS d FROM pg_trigger WHERE tgrelid = 'public.assessment_run_coverage'::regclass AND NOT tgisinternal ORDER BY tgname`,
  );
  const functions = await rows<{ d: string }>(
    db,
    sql`SELECT pg_get_functiondef(p.oid) AS d FROM pg_proc p WHERE p.proname = 'assessment_run_coverage_insert_guard'`,
  );
  const columns = await rows<{ d: string }>(
    db,
    sql`SELECT column_name || ' ' || data_type || ' ' || is_nullable AS d FROM information_schema.columns WHERE table_name = 'assessment_run_coverage' ORDER BY ordinal_position`,
  );
  return [...constraints, ...triggers, ...functions, ...columns].map((r) => r.d);
}
const tableCount = async (db: TestDatabase['db'], name: string): Promise<number> =>
  (
    await rows<{ n: number }>(
      db,
      sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${name}`,
    )
  )[0]?.n ?? -1;
const migrationRows = async (db: TestDatabase['db']): Promise<number> =>
  (
    await rows<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)
  )[0]?.n ?? -1;

const ids = {
  event: '00000000-0000-4000-8000-000000000001',
  actor: '00000000-0000-4000-8000-000000000002',
  project: '00000000-0000-4000-8000-000000000003',
};
async function seedHistory(db: TestDatabase['db']): Promise<void> {
  await db.execute(
    sql`INSERT INTO events (id, name, slug) VALUES (${ids.event}, 'Old event', 'old-event')`,
  );
  await db.execute(
    sql`INSERT INTO actors (id, issuer, subject) VALUES (${ids.actor}, 'urn:old', 'organizer')`,
  );
  await db.execute(
    sql`INSERT INTO projects (id, event_id, name) VALUES (${ids.project}, ${ids.event}, 'Historic project')`,
  );
}
async function historyIntact(db: TestDatabase['db']): Promise<void> {
  const p = await rows<{ name: string }>(
    db,
    sql`SELECT name FROM projects WHERE id = ${ids.project}`,
  );
  expect(p.map((r) => r.name)).toEqual(['Historic project']);
  const claims = await rows<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM events WHERE id = ${ids.event}`,
  );
  expect(claims[0]?.n).toBe(1);
}
async function assertFullyMigrated(db: TestDatabase['db']): Promise<void> {
  const diagnosis = await diagnoseMigrations(db, migrationsFolder);
  expect(diagnosis.notApplied).toEqual([]);
  expect(diagnosis.skipped).toEqual([]);
  const objects = await verifySchemaObjects(db, migrationsFolder);
  expect(objects.missing).toEqual([]);
  expect(await tableCount(db, 'assessment_run_coverage')).toBe(1);
}

describe.each(emptyDatabaseTargets())('migration upgrade matrix on %s', (_name, open) => {
  async function withDb(run: (t: TestDatabase) => Promise<void>): Promise<void> {
    const t = await open();
    try {
      await run(t);
    } finally {
      await t.close();
    }
  }
  /** The fingerprint of a database built fresh through the final migration (the reference every path must equal). */
  async function referenceFingerprint(): Promise<string[]> {
    let reference: string[] = [];
    await withDb(async (t) => {
      await migrateFolder(t, migrationsFolder);
      reference = await coverageFingerprint(t.db);
    });
    return reference;
  }

  it('fresh installation through the final migration: every journal entry recorded once, every schema object present', async () => {
    await withDb(async (t) => {
      await migrateFolder(t, migrationsFolder);
      await assertFullyMigrated(t.db);
      expect(await migrationRows(t.db)).toBe(FINAL + 1);
      const objects = await verifySchemaObjects(t.db, migrationsFolder);
      expect(objects.missing).toEqual([]);
    });
  });

  it.each([16, 18, 19])(
    'existing installation through 0%s: upgrades, keeps every row, and ends identical to a fresh install',
    async (last) => {
      const reference = await referenceFingerprint();
      await withDb(async (t) => {
        const old = folderUpTo(last);
        await migrateFolder(t, old);
        expect(await tableCount(t.db, 'assessment_run_coverage')).toBe(0);
        await seedHistory(t.db);
        await migrateFolder(t, migrationsFolder);
        await assertFullyMigrated(t.db);
        await historyIntact(t.db);
        expect(await coverageFingerprint(t.db)).toEqual(reference);
      });
    },
  );

  it('REPRODUCTION of R7E: the folder shipped in R1 reports success from 0019 but never creates the coverage table; the repaired folder then does', async () => {
    await withDb(async (t) => {
      await migrateFolder(t, folderUpTo(19));
      await seedHistory(t.db);
      const shipped = r1Folder();
      expect(checkMigrationJournal(shipped).join('\n')).toContain('would SKIP it');
      await migrateFolder(t, shipped); // exits normally
      expect(await tableCount(t.db, 'assessment_run_coverage')).toBe(0);
      const diagnosis = await diagnoseMigrations(t.db, shipped);
      expect(diagnosis.skipped).toEqual(['0020_p6b_beta3_r1_coverage_record']);
      expect((await verifySchemaObjects(t.db, shipped)).missing).toContain(
        'table assessment_run_coverage',
      );
      // the startup guard of the services refuses to run against this database
      await expect(assertSchemaReady(t.db, shipped)).rejects.toThrow(SchemaNotReadyError);
      // the repaired journal applies it, without touching what is there
      await migrateFolder(t, migrationsFolder);
      await assertFullyMigrated(t.db);
      await expect(assertSchemaReady(t.db)).resolves.toBeUndefined();
      await historyIntact(t.db);
    });
  });

  it('installation that ALREADY contains the coverage table (built fresh from the R1 folder): the repaired folder re-runs 0020 harmlessly and the result equals a fresh install', async () => {
    const reference = await referenceFingerprint();
    await withDb(async (t) => {
      await migrateFolder(t, r1Folder());
      expect(await tableCount(t.db, 'assessment_run_coverage')).toBe(1);
      await seedHistory(t.db);
      await migrateFolder(t, migrationsFolder);
      await assertFullyMigrated(t.db);
      await historyIntact(t.db);
      expect(await coverageFingerprint(t.db)).toEqual(reference);
    });
  });

  it('repeated execution is a no-op: no new bookkeeping rows, no duplicated or altered data', async () => {
    await withDb(async (t) => {
      await migrateFolder(t, folderUpTo(19));
      await seedHistory(t.db);
      await migrateFolder(t, migrationsFolder);
      const before = await migrationRows(t.db);
      const fingerprint = await coverageFingerprint(t.db);
      await migrateFolder(t, migrationsFolder);
      await migrateFolder(t, migrationsFolder);
      expect(await migrationRows(t.db)).toBe(before);
      expect(await coverageFingerprint(t.db)).toEqual(fingerprint);
      await historyIntact(t.db);
      await assertFullyMigrated(t.db);
    });
  });

  it('an interrupted upgrade (a later statement fails) rolls back completely, and the retry succeeds', async () => {
    await withDb(async (t) => {
      await migrateFolder(t, folderUpTo(19));
      await seedHistory(t.db);
      const { root, journalPath } = copyFolder();
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as JournalFile;
      const last = journal.entries[journal.entries.length - 1];
      if (!last) throw new Error('empty journal');
      journal.entries.push({
        idx: last.idx + 1,
        version: last.version,
        when: last.when + 1,
        tag: `${String(last.idx + 1).padStart(4, '0')}_interrupted`,
        breakpoints: true,
      });
      writeFileSync(journalPath, JSON.stringify(journal));
      writeFileSync(
        join(root, `${String(last.idx + 1).padStart(4, '0')}_interrupted.sql`),
        'CREATE TABLE "r2_interrupted_probe" (id int);\n--> statement-breakpoint\nSELECT 1/0;',
      );
      const rowsBefore = await migrationRows(t.db);
      await expect(migrateFolder(t, root)).rejects.toThrow();
      // atomic: neither 0020 nor the probe table nor any bookkeeping row exists
      expect(await tableCount(t.db, 'assessment_run_coverage')).toBe(0);
      expect(await tableCount(t.db, 'r2_interrupted_probe')).toBe(0);
      expect(await migrationRows(t.db)).toBe(rowsBefore);
      await migrateFolder(t, migrationsFolder);
      await assertFullyMigrated(t.db);
      await historyIntact(t.db);
    });
  });

  it('inconsistent state: bookkeeping says 0020 is applied but the table is gone. The migrator no-ops; the verifier names the damage; the documented recovery repairs it', async () => {
    await withDb(async (t) => {
      await migrateFolder(t, migrationsFolder);
      await t.db.execute(sql`DROP TABLE assessment_run_coverage`);
      await migrateFolder(t, migrationsFolder); // reports success, repairs nothing
      expect(await tableCount(t.db, 'assessment_run_coverage')).toBe(0);
      expect((await diagnoseMigrations(t.db, migrationsFolder)).ok).toBe(true);
      const objects = await verifySchemaObjects(t.db, migrationsFolder);
      expect(objects.ok).toBe(false);
      expect(objects.missing).toEqual(expect.arrayContaining(['table assessment_run_coverage']));
      // docs/MIGRATIONS.md section 6.4: remove ONLY the 0020 bookkeeping row, then migrate (0020 is idempotent). Disposable database only.
      await t.db.execute(
        sql`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1792108000000`,
      );
      await migrateFolder(t, migrationsFolder);
      await assertFullyMigrated(t.db);
    });
  });

  it('drift inside the table: a missing guard trigger is reported by the schema check although the bookkeeping is complete', async () => {
    await withDb(async (t) => {
      await migrateFolder(t, migrationsFolder);
      await t.db.execute(
        sql`DROP TRIGGER assessment_run_coverage_immutable_guard ON assessment_run_coverage`,
      );
      expect((await diagnoseMigrations(t.db, migrationsFolder)).ok).toBe(true);
      expect((await verifySchemaObjects(t.db, migrationsFolder)).missing).toEqual([
        'trigger assessment_run_coverage.assessment_run_coverage_immutable_guard',
      ]);
    });
  });
});
