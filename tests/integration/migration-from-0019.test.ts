/*
 * P6B-beta3-R2 (P1): the upgrade that R7E found broken, with REAL assessments. A database is filled by the real pipeline (clean, partial-capture,
 * a run refused at the coverage gate, one per selection policy), then returned to the state a 0019 installation has -- no coverage table, no
 * bookkeeping row for 0020 -- and upgraded with the real migrator. Afterwards the schema OBJECTS are checked (not the exit code), historical
 * reads must give exactly what they gave before, nothing stored may change, and new runs must write verifying coverage records.
 *
 * Construction note: the pre-upgrade rows are written by this branch's pipeline (the 0019-era code cannot be run against a 0019 schema from this
 * tree, because the pipeline now writes the coverage table). The tables that matter to a 0019 installation -- snapshots, artifacts, extractions,
 * assessments, judgments -- are the same tables with the same rules; only the coverage rows are removed to reproduce 0019's state.
 */
import { canonicalJson } from '../../packages/context/src/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../../packages/database/src/client.js';
import {
  assertSchemaReady,
  AssessmentReadStore,
  clearProvenanceMemo,
  diagnoseMigrations,
  verifySchemaObjects,
  type JudgeDatabase,
} from '../../packages/database/src/index.js';
import { migrateFolder, rows, sql } from '../../packages/database/src/testing/databases.js';
import { testDatabaseTargets, type TestDatabase } from '../../apps/worker/src/testing/harness.js';
import { execute, type Executed } from '../../apps/worker/src/testing/run.js';

const source = (tag: string, lines: number): string =>
  Array.from({ length: lines }, (_, i) => `export const ${tag}_${String(i)} = ${String(i)};`).join(
    '\n',
  );
const packages = (count: number, lines: number) =>
  Array.from({ length: count }, (_, i) => ({
    path: `packages/pkg-${String(i)}/src/index.ts`,
    text: source(`pkg${String(i)}`, lines),
  }));
const WHEN_0020 = 1792108000000;
const TABLES = [
  'source_snapshots',
  'source_snapshot_artifacts',
  'graph_extractions',
  'pre_interview_assessments',
  'assessment_dimension_judgments',
  'assessment_run_inputs',
  'assessment_run_input_snapshots',
  'analysis_runs',
];

describe.each(testDatabaseTargets())(
  'upgrading a 0019 installation that holds real assessments on %s',
  (_name, open) => {
    let testDb: TestDatabase;
    let db: JudgeDatabase;
    const runs: [string, Executed][] = [];
    const before = new Map<string, string>();
    const digests = new Map<string, string>();

    const digestOf = async (table: string): Promise<string> =>
      (
        await rows<{ d: string }>(
          db,
          sql.raw(
            `SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), 'empty') AS d FROM ${table} t`,
          ),
        )
      )[0]?.d ?? '';
    const viewOf = async (run: Executed): Promise<string> => {
      const reads = new AssessmentReadStore(db);
      const projectId = run.world.project.id;
      const [assessment] = await run.assessments();
      if (!assessment) {
        const v = await reads.getRun(projectId, run.runId);
        return canonicalJson({ state: v?.state, code: v?.failureCode, usage: v?.usage });
      }
      const detail = await reads.getDetail(projectId, assessment.id);
      const listed = (await reads.list(projectId)).find((a) => a.id === assessment.id);
      return canonicalJson({
        verified: detail?.verified,
        report: detail?.report,
        judgments: detail?.judgments,
        limitations: detail?.limitations.map((l) => l.code),
        overall: listed?.overall,
        listedVerified: listed?.verified,
      });
    };

    beforeAll(async () => {
      testDb = await open();
      db = testDb.db;
      runs.push(['clean', await execute(db, {})]);
      runs.push([
        'partial capture and sampled source',
        await execute(db, {
          worldOptions: { extraFiles: packages(8, 200), partialRepository: true },
          models: { windowing: { source: 9_000 } },
        }),
      ]);
      runs.push(['source-selection/v1', await execute(db, { selection: 'source-selection/v1' })]);
      runs.push(['source-selection/v2', await execute(db, { selection: 'source-selection/v2' })]);
      runs.push([
        'refused at the coverage gate',
        await execute(db, {
          worldOptions: { extraFiles: packages(8, 200) },
          models: { windowing: { source: 1_000 } },
        }),
      ]);
      for (const [name, run] of runs) before.set(name, await viewOf(run));
      // the reads before the downgrade already verify their coverage (the baseline for "older runs now report not recorded")
      for (const table of TABLES) digests.set(table, await digestOf(table));
      // ---- become a 0019 installation -----------------------------------------------------------------------------------------------
      await db.execute(sql`DROP TABLE assessment_run_coverage`);
      await db.execute(sql`DROP FUNCTION assessment_run_coverage_insert_guard()`);
      await db.execute(
        sql`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = ${WHEN_0020}`,
      );
      clearProvenanceMemo();
    });
    afterAll(async () => {
      await testDb.close();
    });

    it('is in the state of a 0019 installation: the schema check names the missing coverage objects and the services refuse to start on it', async () => {
      const objects = await verifySchemaObjects(db, migrationsFolder);
      expect(objects.missing).toEqual(
        expect.arrayContaining([
          'table assessment_run_coverage',
          'function assessment_run_coverage_insert_guard',
        ]),
      );
      expect((await diagnoseMigrations(db, migrationsFolder)).notApplied).toEqual([
        '0020_p6b_beta3_r1_coverage_record',
      ]);
      await expect(assertSchemaReady(db)).rejects.toThrow(/does not match this version/);
    });

    it('upgrades with the real migrator; the schema objects exist and the constraints and triggers hold', async () => {
      await migrateFolder(testDb, migrationsFolder);
      expect((await verifySchemaObjects(db, migrationsFolder)).missing).toEqual([]);
      await expect(assertSchemaReady(db)).resolves.toBeUndefined();
      const triggers = await rows<{ tgname: string }>(
        db,
        sql`SELECT tgname FROM pg_trigger WHERE tgrelid = 'assessment_run_coverage'::regclass AND NOT tgisinternal ORDER BY 1`,
      );
      expect(triggers.map((t) => t.tgname)).toEqual([
        'assessment_run_coverage_immutable_guard',
        'assessment_run_coverage_insert_guard',
        'assessment_run_coverage_no_truncate',
      ]);
      const constraints = await rows<{ conname: string }>(
        db,
        sql`SELECT conname FROM pg_constraint WHERE conrelid = 'assessment_run_coverage'::regclass ORDER BY 1`,
      );
      expect(constraints.map((c) => c.conname)).toEqual(
        expect.arrayContaining([
          'assessment_run_coverage_hash_hex',
          'assessment_run_coverage_hash_matches_text',
          'assessment_run_coverage_run_same_project_fk',
          'assessment_run_coverage_text_bounded',
          'assessment_run_coverage_verdict_valid',
        ]),
      );
    });

    it('every historical row is preserved byte for byte', async () => {
      for (const table of TABLES) expect(await digestOf(table), table).toBe(digests.get(table));
    });

    it('historical assessments read exactly as before (scores, reports, verification), and report coverage as NOT RECORDED, never complete', async () => {
      const reads = new AssessmentReadStore(db);
      for (const [name, run] of runs) {
        expect(await viewOf(run), name).toBe(before.get(name));
        const [assessment] = await run.assessments();
        if (assessment) {
          const detail = await reads.getDetail(run.world.project.id, assessment.id);
          expect(detail?.verified, name).toBe(true);
          expect(detail?.coverage, name).toMatchObject({
            status: 'not_recorded',
            verified: false,
            verdict: null,
            measures: null,
          });
          const listed = (await reads.list(run.world.project.id)).find(
            (a) => a.id === assessment.id,
          );
          expect(listed?.coverage, name).toMatchObject({
            status: 'not_recorded',
            verified: false,
            verdict: null,
          });
        } else {
          expect((await reads.getRun(run.world.project.id, run.runId))?.coverage).toMatchObject({
            status: 'not_recorded',
            verified: false,
          });
        }
      }
    });

    it('new runs write coverage records that verify against their immutable evidence', async () => {
      const fresh = await execute(db, {
        worldOptions: { extraFiles: packages(8, 200), partialRepository: true },
        models: { windowing: { source: 9_000 } },
      });
      expect(fresh.outcome.kind).toBe('succeeded');
      const [assessment] = await fresh.assessments();
      const detail = await new AssessmentReadStore(db).getDetail(
        fresh.world.project.id,
        assessment?.id ?? '',
      );
      expect(detail?.coverage).toMatchObject({
        status: 'recorded',
        verified: true,
        provenance: { method: 'recomputed_from_snapshots', budgets: 'pinned_by_extraction' },
      });
      const refused = await execute(db, {
        worldOptions: { extraFiles: packages(8, 200) },
        models: { windowing: { source: 1_000 } },
      });
      expect(refused.outcome).toMatchObject({
        kind: 'failed',
        code: 'source_coverage_insufficient',
      });
      expect(
        (await new AssessmentReadStore(db).getRun(refused.world.project.id, refused.runId))
          ?.coverage,
      ).toMatchObject({ status: 'recorded', verified: true, verdict: 'insufficient' });
    });

    it('running the migrator again changes nothing', async () => {
      const countRows = async (): Promise<number> =>
        (
          await rows<{ n: number }>(
            db,
            sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
          )
        )[0]?.n ?? -1;
      const rowsBefore = await countRows();
      const snapshot = new Map<string, string>();
      for (const table of [...TABLES, 'assessment_run_coverage'])
        snapshot.set(table, await digestOf(table));
      await migrateFolder(testDb, migrationsFolder);
      await migrateFolder(testDb, migrationsFolder);
      expect(await countRows()).toBe(rowsBefore);
      for (const [table, digest] of snapshot) expect(await digestOf(table), table).toBe(digest);
      expect((await verifySchemaObjects(db, migrationsFolder)).missing).toEqual([]);
    });
  },
);
