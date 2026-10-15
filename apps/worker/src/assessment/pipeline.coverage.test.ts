import { assessmentRunCalls, type JudgeDatabase } from '@judge-copilot/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseTargets, type TestDatabase } from '../testing/harness.js';
import { execute, expectNoAssessment } from '../testing/run.js';

/*
 * P6B-beta3 (R9-B1): what the pipeline does with the coverage of the selected evidence. An unseen implementation is never scored with
 * confidence: when too little of it was shown the run stops BEFORE any spend; when some of it was not shown the assessor is told so.
 */

/** A unique, source-looking file of `lines` lines (every line distinct so nothing is a duplicate). */
const sourceOf = (tag: string, lines: number): string =>
  Array.from({ length: lines }, (_, i) => `export const ${tag}_${String(i)} = ${String(i)};`).join(
    '\n',
  );
const packages = (count: number, lines: number) =>
  Array.from({ length: count }, (_, i) => ({
    path: `packages/pkg-${String(i)}/src/index.ts`,
    text: sourceOf(`pkg${String(i)}`, lines),
  }));

/** The notices of the unit as the assessor was shown them (parsed from the rendered request, not from the schema that lists every code). */
function noticesShown(request: { user: readonly string[] }): string[] {
  const match = /"notices":\[([^\]]*)\],"scale"/.exec(request.user.join('\n'));
  if (!match) throw new Error('no notices in the rendered unit');
  return (match[1] ?? '')
    .split(',')
    .filter(Boolean)
    .map((code) => code.replace(/"/g, ''));
}

describe.each(testDatabaseTargets())('coverage handling in the pipeline on %s', (_name, open) => {
  let database: TestDatabase;
  let db: JudgeDatabase;
  beforeAll(async () => {
    database = await open();
    db = database.db;
  });
  afterAll(async () => {
    await database.close();
  });

  it('stops BEFORE any spend when too little of the implementation was shown (fewer than half of its components), and writes no assessment', async () => {
    const run = await execute(db, {
      worldOptions: { extraFiles: packages(8, 200) },
      models: { windowing: { source: 1_000 } },
    });
    expect(run.outcome).toMatchObject({
      kind: 'failed',
      category: 'source_unavailable',
      code: 'source_coverage_insufficient',
      stage: 'select',
    });
    expect(run.model.calls).toHaveLength(0);
    expect(
      await db.select().from(assessmentRunCalls).where(eq(assessmentRunCalls.runId, run.runId)),
    ).toHaveLength(0);
    await expectNoAssessment(run, db);
  });

  it('proceeds when the repository is only partly shown, tells the assessor of every dimension, and discloses it in the limitations', async () => {
    const run = await execute(db, {
      worldOptions: { extraFiles: packages(6, 200) },
      models: { windowing: { source: 9_000 } },
    });
    expect(run.outcome.kind).toBe('succeeded');
    const dimensionCalls = run.model.callsOf('dimension_assessment');
    expect(dimensionCalls.length).toBeGreaterThan(0);
    for (const call of dimensionCalls) {
      expect(noticesShown(call.request)).toContain('sampled_source');
    }
    const [assessment] = await run.assessments();
    const codes = (assessment?.limitations as { code: string }[]).map((l) => l.code);
    expect(codes).toContain('source_sampled');
    expect(codes).toContain('implementation_partially_seen');
  });

  it('adds no notice and no coverage limitation when everything fits (nothing changes for a small repository)', async () => {
    const run = await execute(db, {});
    expect(run.outcome.kind).toBe('succeeded');
    for (const call of run.model.callsOf('dimension_assessment')) {
      expect(noticesShown(call.request)).toEqual([]);
    }
    const [assessment] = await run.assessments();
    const codes = (assessment?.limitations as { code: string }[]).map((l) => l.code);
    expect(codes.filter((code) => code.endsWith('_seen') || code === 'source_sampled')).toEqual([]);
  });

  it('tells the assessor when the repository capture itself was partial', async () => {
    const run = await execute(db, { worldOptions: { partialRepository: true } });
    expect(run.outcome.kind).toBe('succeeded');
    for (const call of run.model.callsOf('dimension_assessment')) {
      expect(noticesShown(call.request)).toContain('partial_capture');
    }
  });
});
