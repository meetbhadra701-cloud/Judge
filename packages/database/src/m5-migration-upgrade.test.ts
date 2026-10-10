import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deterministicIdAllocator } from '@judge-copilot/evidence';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssessmentRunStore } from './assessment-run-store.js';
import { migrationsFolder } from './client.js';
import { EvidenceGraphStore } from './evidence-graph-store.js';
import { requestInput } from './testing/assessment-fixtures.js';
import { seedAssessmentWorld } from './testing/assessment-world.js';
import {
  emptyDatabaseTargets,
  expectPgError,
  migrateFolder,
  rows,
  sql,
  SQLSTATE,
  type TestDatabase,
} from './testing/databases.js';
import { README_TEXT, seedGraphWorld, span } from './testing/graph-world.js';

/*
 * M5 P4 over an existing, populated M4-baseline database: migrations 0000-0009 are applied (the M4 baseline has no database changes of
 * its own), M3 data and an old analysis run are written, then 0010-0011 are applied on top. Nothing that existed may change, the new
 * constraints and triggers must be active, and a full assessment request must work on the upgraded data.
 */

function baselineFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'judge-m4-migrations-'));
  mkdirSync(join(folder, 'meta'));
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as {
    entries: { idx: number; tag: string }[];
  };
  const kept = journal.entries.filter((entry) => entry.idx <= 9);
  expect(kept.map((entry) => entry.tag).at(-1)).toBe('0009_m3_supersession_guard_hardening');
  for (const entry of kept)
    cpSync(join(migrationsFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: kept }),
  );
  return folder;
}

describe.each(emptyDatabaseTargets())(
  'M4 baseline -> M5 P4 migration upgrade on %s',
  (_name, open) => {
    let testDb: TestDatabase;

    beforeAll(async () => {
      testDb = await open();
    });
    afterAll(async () => {
      await testDb.close();
    });

    it('adds the assessment tables over populated data without changing any of it, and the new rules are active', async () => {
      await migrateFolder(testDb, baselineFolder());
      const before = await rows<{ table_name: string }>(
        testDb.db,
        sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'assessment_%' OR table_name IN ('graph_extractions', 'pre_interview_assessments')`,
      );
      expect(before).toEqual([]);

      const world = await seedGraphWorld(testDb.db);
      const graphStore = new EvidenceGraphStore({
        db: testDb.db,
        ids: deterministicIdAllocator('m5-upgrade'),
      });
      const readme = world.snapshots.github.artifacts.find((a) => a.key === 'files/README.md');
      await graphStore.createGraph(
        world.project.id,
        {
          claims: [
            {
              ref: 'c',
              text: 'The project documents a health endpoint.',
              verificationLevel: 'team_claim',
            },
          ],
          evidence: [
            {
              ref: 'e',
              kind: 'fact',
              origin: 'github',
              verificationLevel: 'unverified',
              text: 'README mentions GET /health.',
              provenance: {
                snapshotId: world.snapshots.github.snapshot.id,
                artifactId: readme?.id,
                span: span(README_TEXT, 'GET /health'),
              },
            },
          ],
          relations: [{ claim: { ref: 'c' }, evidence: { ref: 'e' }, type: 'supports' }],
        },
        null,
      );
      await testDb.db.execute(
        sql`INSERT INTO analysis_runs (run_type, state, finished_at, failure_category) VALUES ('foundation_check', 'failed', now() + interval '1 second', 'timeout')`,
      );
      const snapshot = async () => ({
        graph: await rows(
          testDb.db,
          sql`SELECT c.id, c.text, e.id AS eid, e.excerpt FROM claims c, evidence_items e ORDER BY c.id, e.id`,
        ),
        runs: await rows(
          testDb.db,
          sql`SELECT id, run_type, state, failure_category FROM analysis_runs ORDER BY id`,
        ),
        snapshots: await rows(
          testDb.db,
          sql`SELECT id, content_hash, status FROM source_snapshots ORDER BY id`,
        ),
      });
      const baseline = await snapshot();

      await migrateFolder(testDb, migrationsFolder);

      expect(await snapshot()).toEqual(baseline);
      const tables = await rows<{ table_name: string }>(
        testDb.db,
        sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND (table_name LIKE 'assessment_%' OR table_name IN ('graph_extractions', 'graph_extraction_items', 'pre_interview_assessments')) ORDER BY table_name`,
      );
      expect(tables.map((t) => t.table_name)).toEqual([
        'assessment_dimension_judgments',
        'assessment_judgment_citations',
        'assessment_requests',
        'assessment_run_budget',
        'assessment_run_calls',
        'assessment_run_extractions',
        'assessment_run_input_snapshots',
        'assessment_run_inputs',
        'assessment_run_outcomes',
        'graph_extraction_items',
        'graph_extractions',
        'pre_interview_assessments',
      ]);
      // the older guards still hold, and the new failure category is confined to assessment runs
      await expectPgError(
        testDb.db.execute(sql`DELETE FROM source_snapshots`),
        SQLSTATE.RESTRICT_VIOLATION,
      );
      await expectPgError(
        testDb.db.execute(
          sql`INSERT INTO analysis_runs (run_type, state, finished_at, failure_category) VALUES ('foundation_check', 'failed', now() + interval '1 second', 'budget_exceeded')`,
        ),
        SQLSTATE.CHECK_VIOLATION,
      );
      // and a real assessment request works on the upgraded database
      const assessmentWorld = await seedAssessmentWorld(testDb.db, {
        trackKeys: ['health'],
        declare: ['health'],
      });
      const result = await new AssessmentRunStore({ db: testDb.db }).requestAssessment(
        requestInput(assessmentWorld),
      );
      expect(result.kind).toBe('run_created');
    });
  },
);
