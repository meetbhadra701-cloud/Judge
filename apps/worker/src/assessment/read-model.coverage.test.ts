import { AssessmentReadStore, type JudgeDatabase } from '@judge-copilot/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withGuardsDisabled } from '../testing/corrupt.js';
import { testDatabaseTargets, type TestDatabase } from '../testing/harness.js';
import { execute, type Executed } from '../testing/run.js';

/*
 * P6B-beta3-R1 (R7D findings 3, 4, 7): the coverage the API discloses. A verified record is summarised for the judge; a record that fails
 * its checks shows nothing derived from it; a historical assessment (no record) is `not_recorded`, never "complete"; the API discloses
 * partial coverage next to the scored headline, in the list and in the detail.
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

describe.each(testDatabaseTargets())('read model: coverage on %s', (_name, open) => {
  let database: TestDatabase;
  let db: JudgeDatabase;
  beforeAll(async () => {
    database = await open();
    db = database.db;
  });
  afterAll(async () => {
    await database.close();
  });

  const idOf = async (run: Executed): Promise<string> => {
    const [assessment] = await run.assessments();
    if (!assessment) throw new Error('no assessment');
    return assessment.id;
  };

  it('a partially examined repository is disclosed in the detail, the list and the full record', async () => {
    const run = await execute(db, {
      worldOptions: { extraFiles: packages(6, 200), partialRepository: true },
      models: { windowing: { source: 9_000 } },
    });
    expect(run.outcome.kind).toBe('succeeded');
    const reads = new AssessmentReadStore(db);
    const projectId = run.world.project.id;
    const id = await idOf(run);

    const detail = await reads.getDetail(projectId, id);
    expect(detail?.verified).toBe(true);
    expect(detail?.coverage).toMatchObject({
      status: 'recorded',
      verified: true,
      relevance: 'not_established',
      roleBasis: 'path_only',
    });
    expect(detail?.coverage.verdict).not.toBe('complete');
    expect(detail?.coverage.concerns).toContain('implementation_partially_seen');
    expect(detail?.coverage.snapshots.some((s) => s.status === 'partial')).toBe(true);
    expect(detail?.coverage.omittedComponents.length).toBeGreaterThan(0);
    expect(detail?.coverage.assessorNotices).toEqual(
      expect.arrayContaining(['sampled_source', 'partial_capture']),
    );
    expect(detail?.limitations.map((l) => l.code)).toContain('partial_capture');

    const listed = (await reads.list(projectId)).find((a) => a.id === id);
    expect(listed?.coverage).toMatchObject({ status: 'recorded', verified: true });
    expect(listed?.coverage.partialCapture).toBe(true);
    expect(listed?.coverage.concerns).toContain('implementation_partially_seen');

    const full = await reads.getCoverage(projectId, id);
    expect(full?.record?.artifacts.length).toBeGreaterThan(0);
    expect(full?.view.recordSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await reads.getCoverage(projectId, '00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(await reads.getCoverage(crypto.randomUUID(), id)).toBeNull();
  });

  it('an assessment with no coverage record (made before they existed) is not_recorded, and still scored but never "complete"', async () => {
    const run = await execute(db);
    const id = await idOf(run);
    await withGuardsDisabled(
      db,
      ['coverage'],
      [sql`DELETE FROM assessment_run_coverage WHERE run_id = ${run.runId}`],
    );
    const reads = new AssessmentReadStore(db);
    const detail = await reads.getDetail(run.world.project.id, id);
    expect(detail?.verified).toBe(true);
    expect(detail?.coverage).toMatchObject({
      status: 'not_recorded',
      verified: false,
      verdict: null,
      measures: null,
    });
    const listed = (await reads.list(run.world.project.id)).find((a) => a.id === id);
    expect(listed?.coverage).toMatchObject({
      status: 'not_recorded',
      verified: false,
      verdict: null,
    });
  });

  it.each([
    [
      'a verdict changed in the mirror',
      (runId: string) =>
        sql`UPDATE assessment_run_coverage SET record = jsonb_set(record, '{verdict}', '"complete"') WHERE run_id = ${runId}`,
      'record_mirror_differs',
    ],
    [
      'a forged record: verdict changed with text, hash and mirror all rewritten consistently',
      (runId: string) =>
        sql`UPDATE assessment_run_coverage SET
              record_canonical = replace(record_canonical, '"verdict":"partial"', '"verdict":"complete"'),
              record_sha256 = encode(sha256(convert_to(replace(record_canonical, '"verdict":"partial"', '"verdict":"complete"'), 'UTF8')), 'hex'),
              record = replace(record_canonical, '"verdict":"partial"', '"verdict":"complete"')::jsonb,
              verdict = 'complete'
            WHERE run_id = ${runId}`,
      'record_inconsistent',
    ],
  ])(
    '%s: the coverage view shows nothing derived from the record',
    async (_label, corrupt, problem) => {
      const run = await execute(db, {
        worldOptions: { extraFiles: packages(6, 200) },
        models: { windowing: { source: 9_000 } },
      });
      const id = await idOf(run);
      const reads = new AssessmentReadStore(db);
      const good = await reads.getDetail(run.world.project.id, id);
      expect(good?.coverage.verified).toBe(true);
      await withGuardsDisabled(db, ['coverage'], [corrupt(run.runId)]);
      const detail = await reads.getDetail(run.world.project.id, id);
      expect(detail?.verified).toBe(true);
      expect(detail?.coverage).toMatchObject({
        status: 'recorded',
        verified: false,
        verdict: null,
        measures: null,
        concerns: [],
        omittedComponents: [],
      });
      expect(detail?.coverage.problems).toContain(problem);
      expect((await reads.getCoverage(run.world.project.id, id))?.record).toBeNull();
    },
  );

  it('the database itself refuses a stored text whose hash differs, even with the immutability guard off', async () => {
    const run = await execute(db, { worldOptions: { extraFiles: packages(2, 40) } });
    await expect(
      withGuardsDisabled(
        db,
        ['coverage'],
        [
          sql`UPDATE assessment_run_coverage SET record_canonical = replace(record_canonical, 'source-selection/v3', 'source-selection/v9') WHERE run_id = ${run.runId}`,
        ],
      ),
    ).rejects.toThrow();
  });

  it('removing a limitation the record says reached the assessors is detected', async () => {
    const run = await execute(db, {
      worldOptions: { extraFiles: packages(6, 200), partialRepository: true },
      models: { windowing: { source: 9_000 } },
    });
    const id = await idOf(run);
    await withGuardsDisabled(
      db,
      ['assessments'],
      [sql`UPDATE pre_interview_assessments SET limitations = '[]'::jsonb WHERE id = ${id}`],
    );
    const detail = await new AssessmentReadStore(db).getDetail(run.world.project.id, id);
    expect(detail?.coverage.verified).toBe(false);
    expect(detail?.coverage.problems).toContain('limitations_missing_from_assessment');
  });
});
