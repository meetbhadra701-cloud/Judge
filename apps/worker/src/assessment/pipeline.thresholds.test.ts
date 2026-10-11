import { technicalThreshold } from '@judge-copilot/assessment';
import { assessmentDimensionJudgments, type JudgeDatabase } from '@judge-copilot/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeModel, insufficient, unitOf } from '../testing/fake-model.js';
import { testDatabaseTargets, type TestDatabase } from '../testing/harness.js';
import { execute, expectNoAssessment, type Executed } from '../testing/run.js';

/*
 * Design §9.3 (owner correction C6): the run fails when technical >= T = max(2, ceil(0.25 U)) OR when EVERY unit ended technical.
 * Valid insufficiency (assessor-reported, pre-gated) and substantive critic rejection are never technical.
 */

type Behavior = 'schema' | 'domain' | 'insufficient';

function criteria(count: number) {
  if (count === 1) return [{ key: 'crit_01', weight: 1, anchors: [] }];
  if (count === 2) return undefined; // the default two-criterion rubric
  if (count === 5) {
    return [0.3, 0.2, 0.2, 0.2, 0.1].map((weight, index) => ({
      key: `crit_0${String(index + 1)}`,
      weight,
      anchors: [],
    }));
  }
  return undefined; // 36: generated, unweighted
}

function worldFor(count: number) {
  const list = criteria(count);
  if (list) return { criterionList: list };
  return count === 2 ? {} : { criteria: count };
}

/** An assessor that misbehaves in the given way on the given dimensions and is honest everywhere else. */
function assessorModel(misbehave: ReadonlyMap<string, Behavior>): FakeModel {
  return new FakeModel().on('dimension_assessment', (context) => {
    const { dimensionId } = unitOf(context);
    const behavior = misbehave.get(dimensionId);
    const handle =
      context.records.find((r) => r.meta['authorship'] === 'team_statement')?.handle ?? '';
    if (behavior === 'schema') return 'this is not even JSON of the right shape';
    if (behavior === 'insufficient') return insufficient(dimensionId);
    return {
      dimensionId,
      outcome: { kind: 'scored', score: 6 },
      citations: [
        {
          evidence: behavior === 'domain' ? 'E-099' : handle,
          directness: 'direct',
          specificity: 'exact',
          note: 'ok',
        },
      ],
      rationale: 'Supported.',
      limitations: [],
    };
  });
}

const ids = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    count === 2 && index === 0
      ? 'official.problem_fit'
      : count === 2
        ? 'official.usability'
        : count === 1
          ? 'official.crit_01'
          : `official.crit_${String(index + 1).padStart(2, '0')}`,
  );

describe.each(testDatabaseTargets())('technical-failure thresholds on %s', (_name, open) => {
  let database: TestDatabase;
  let db: JudgeDatabase;
  beforeAll(async () => {
    database = await open();
    db = database.db;
  });
  afterAll(async () => {
    await database.close();
  });

  const run = (count: number, misbehave: [string, Behavior][]) =>
    execute(db, { worldOptions: worldFor(count), model: assessorModel(new Map(misbehave)) });

  async function failureOf(result: Executed) {
    expect(result.outcome.kind).toBe('failed');
    await expectNoAssessment(result, db);
    const row = await result.run();
    expect(row?.state).toBe('failed');
    return { category: row?.failureCategory, outcome: await result.outcomeRow() };
  }

  it('the threshold function is the design table: T = max(2, ceil(0.25 U))', () => {
    expect([1, 2, 5, 36].map(technicalThreshold)).toEqual([2, 2, 2, 9]);
  });

  describe('U = 1', () => {
    it('a technical failure FAILS the run (rule 2), with nothing persisted', async () => {
      const result = await run(1, [['official.crit_01', 'schema']]);
      const { category, outcome } = await failureOf(result);
      expect(category).toBe('schema_validation_failed');
      expect(outcome).toMatchObject({ outcome: 'failed', failureCode: 'all_units_technical' });
    });

    it('a domain failure carries the domain category', async () => {
      const result = await run(1, [['official.crit_01', 'domain']]);
      expect((await failureOf(result)).category).toBe('domain_validation_failed');
    });

    it('valid insufficiency (the assessor honestly reports it) SUCCEEDS with an insufficient overall', async () => {
      const result = await run(1, [['official.crit_01', 'insufficient']]);
      expect(result.outcome.kind).toBe('succeeded');
      const [assessment] = await result.assessments();
      expect((assessment?.report as { overall: { state: string } }).overall.state).toBe(
        'insufficient_evidence',
      );
      if (result.outcome.kind !== 'succeeded') return;
      const [row] = await db
        .select()
        .from(assessmentDimensionJudgments)
        .where(eq(assessmentDimensionJudgments.assessmentId, result.outcome.assessmentId));
      expect(row?.disposition).toBe('assessor_reported_insufficient');
      expect((await result.run())?.failureCategory).toBeNull();
    });
  });

  describe('U = 2 (T = 2)', () => {
    it('one technical failure passes, two fail', async () => {
      const one = await run(2, [['official.usability', 'schema']]);
      expect(one.outcome.kind).toBe('succeeded');
      const two = await run(
        2,
        ids(2).map((id): [string, Behavior] => [id, 'schema']),
      );
      expect((await failureOf(two)).outcome).toMatchObject({
        failureCode: 'technical_failures_over_threshold',
      });
    });
  });

  describe('U = 5 (T = 2)', () => {
    it('one technical failure passes (20%), two fail (40%) even though three units could be scored', async () => {
      const one = await run(5, [['official.crit_03', 'domain']]);
      expect(one.outcome.kind).toBe('succeeded');
      const two = await run(5, [
        ['official.crit_03', 'domain'],
        ['official.crit_04', 'schema'],
      ]);
      await failureOf(two);
      // it stopped spending at the second failure: crit_05 was never asked about
      expect(two.model.callsOf('dimension_assessment').map((c) => c.dimensionId)).not.toContain(
        'official.crit_05',
      );
    });

    it('every unit valid-insufficient never fails the run', async () => {
      const result = await run(
        5,
        ids(5).map((id): [string, Behavior] => [id, 'insufficient']),
      );
      expect(result.outcome.kind).toBe('succeeded');
      expect((await result.run())?.failureCategory).toBeNull();
    });
  });

  describe('U = 36 (T = 9)', () => {
    it('eight technical failures pass, nine fail', async () => {
      const eight = await run(
        36,
        ids(36)
          .slice(0, 8)
          .map((id): [string, Behavior] => [id, 'schema']),
      );
      expect(eight.outcome.kind).toBe('succeeded');
      const nine = await run(
        36,
        ids(36)
          .slice(0, 9)
          .map((id): [string, Behavior] => [id, 'schema']),
      );
      await failureOf(nine);
    });

    it('all valid-insufficient never fails', async () => {
      const result = await run(
        36,
        ids(36).map((id): [string, Behavior] => [id, 'insufficient']),
      );
      expect(result.outcome.kind).toBe('succeeded');
    });
  });
});
