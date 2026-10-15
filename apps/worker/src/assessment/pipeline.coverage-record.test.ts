import { verifyCoverageRecord } from '@judge-copilot/assessment';
import { assessmentRunCoverage, type JudgeDatabase } from '@judge-copilot/database';
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseTargets, type TestDatabase } from '../testing/harness.js';
import { execute, type Executed } from '../testing/run.js';

/*
 * P6B-beta3-R1 (R7D findings 4 and 7): the run's coverage record is stored before any spend, is content-addressed and immutable, names the
 * limitations that reached the assessors, and an assessment that does not carry them is detectable.
 */

const sourceOf = (tag: string, lines: number): string =>
  Array.from({ length: lines }, (_, i) => `export const ${tag}_${String(i)} = ${String(i)};`).join(
    '\n',
  );
const packages = (count: number, lines: number) =>
  Array.from({ length: count }, (_, i) => ({
    path: `packages/pkg-${String(i)}/src/index.ts`,
    text: sourceOf(`pkg${String(i)}`, lines),
  }));

describe.each(testDatabaseTargets())('coverage record in the pipeline on %s', (_name, open) => {
  let database: TestDatabase;
  let db: JudgeDatabase;
  beforeAll(async () => {
    database = await open();
    db = database.db;
  });
  afterAll(async () => {
    await database.close();
  });

  const rowOf = async (run: Executed) => {
    const [row] = await db
      .select()
      .from(assessmentRunCoverage)
      .where(eq(assessmentRunCoverage.runId, run.runId));
    return row;
  };
  const pinnedIds = async (run: Executed): Promise<string[]> => {
    const rows = await db.execute<{ snapshot_id: string }>(
      sql`SELECT snapshot_id FROM assessment_run_input_snapshots WHERE run_id = ${run.runId}`,
    );
    return (Array.isArray(rows) ? rows : rows.rows).map((r) => r.snapshot_id);
  };

  it('a run that stops at the coverage gate still leaves its record, and spent nothing', async () => {
    const run = await execute(db, {
      worldOptions: { extraFiles: packages(8, 200) },
      models: { windowing: { source: 1_000 } },
    });
    expect(run.outcome).toMatchObject({ kind: 'failed', code: 'source_coverage_insufficient' });
    const row = await rowOf(run);
    expect(row).toMatchObject({ verdict: 'insufficient', selectionPolicy: 'source-selection/v3' });
    expect(run.model.calls).toHaveLength(0);
  });

  it('a successful run stores a record that verifies against its assessment, and the assessment carries every limitation that reached the assessors', async () => {
    const run = await execute(db, {
      worldOptions: { extraFiles: packages(6, 200), partialRepository: true },
      models: { windowing: { source: 9_000 } },
    });
    expect(run.outcome.kind).toBe('succeeded');
    const row = await rowOf(run);
    const [assessment] = await run.assessments();
    if (!row || !assessment) throw new Error('missing rows');
    const verification = verifyCoverageRecord(
      { canonical: row.recordCanonical, sha256: row.recordSha256, mirror: row.record },
      {
        pinnedSnapshotIds: await pinnedIds(run),
        storedLimitations: assessment.limitations as {
          code: string;
          count: number;
          subjects: string[];
        }[],
      },
    );
    expect(verification).toMatchObject({ ok: true, problems: [] });
    const codes = (assessment.limitations as { code: string }[]).map((l) => l.code);
    expect(codes).toContain('partial_capture');
    expect(codes).toContain('implementation_partially_seen');
    expect(verification.record?.assessorInputs.notices).toEqual(
      expect.arrayContaining(['sampled_source', 'partial_capture']),
    );
    // every recorded artifact names its snapshot and carries the hash of the text the shown prefix is recomputed from
    expect(verification.record?.artifacts.length).toBeGreaterThan(0);
    expect(verification.record?.artifacts.every((a) => /^[0-9a-f]{64}$/.test(a.textSha256))).toBe(
      true,
    );
  });

  it('the record is immutable and cannot be added after the run ended', async () => {
    const run = await execute(db, { worldOptions: { extraFiles: packages(2, 40) } });
    expect(run.outcome.kind).toBe('succeeded');
    await expect(
      db.execute(
        sql`UPDATE assessment_run_coverage SET verdict = 'complete' WHERE run_id = ${run.runId}`,
      ),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`DELETE FROM assessment_run_coverage WHERE run_id = ${run.runId}`),
    ).rejects.toThrow();
    await expect(db.execute(sql`TRUNCATE assessment_run_coverage`)).rejects.toThrow();
    const row = await rowOf(run);
    if (!row) throw new Error('missing row');
    await expect(
      db.execute(sql`INSERT INTO assessment_run_coverage
        (run_id, project_id, schema_id, selection_policy, verdict, record_canonical, record_sha256, record)
        SELECT run_id, project_id, schema_id, selection_policy, verdict, record_canonical, record_sha256, record
        FROM assessment_run_coverage WHERE run_id = ${run.runId}`),
    ).rejects.toThrow();
  });

  it('a stored text whose hash or mirror does not match is refused by the database', async () => {
    const run = await execute(db, { worldOptions: { extraFiles: packages(2, 40) } });
    const row = await rowOf(run);
    if (!row) throw new Error('missing row');
    const other = await execute(db, { worldOptions: { extraFiles: packages(3, 40) } });
    await expect(
      db.execute(sql`INSERT INTO assessment_run_coverage
        (run_id, project_id, schema_id, selection_policy, verdict, record_canonical, record_sha256, record)
        VALUES (${other.runId}, ${other.world.project.id}, 'coverage-record/v1', 'source-selection/v3', 'complete',
          '{}', ${row.recordSha256}, '{}'::jsonb)`),
    ).rejects.toThrow();
  });
});
