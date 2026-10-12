import { canonicalReportedScore } from '@judge-copilot/assessment';
import {
  AssessmentReadStore,
  assessmentDimensionJudgments,
  type JudgeDatabase,
} from '@judge-copilot/database';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withGuardsDisabled } from '../testing/corrupt.js';
import { candidateHandles, FakeModel, insufficient, unitOf } from '../testing/fake-model.js';
import { testDatabaseTargets, type TestDatabase } from '../testing/harness.js';
import { execute } from '../testing/run.js';

/*
 * P6A-R2 (R6B P2-1): score precision through the REAL pipeline. The assessor's score is a raw JavaScript number that is persisted as
 * `double precision`; M4 reports it rounded ONCE, half-up, to four decimals (on the decimal the number prints as). The read model's
 * consistency check compares at that canonical precision, so a legitimate assessment verifies whatever its raw score looked like. Before
 * the fix every score with more than four decimals (7.33333, 6.666666666666667) was withheld as `judgment_mismatch_score`.
 *
 * Runs on PGlite and on PostgreSQL 16.
 */

/** Pairs of raw scores for the two dimensions of the default rubric (scale 0..10). */
const PAIRS: readonly [string, number, number][] = [
  ['integers', 7, 3],
  ['minimum and maximum', 0, 10],
  ['one decimal', 7.5, 0.1],
  ['two decimals', 7.25, 3.14],
  ['three decimals', 7.125, 2.718],
  ['four decimals', 7.1234, 9.9999],
  ['five decimals and a repeating decimal (the R6B cases)', 7.33333, 6.666666666666667],
  ['repeating decimals', 3.3333333333333335, 0.6666666666666666],
  ['half-up boundary on the printed decimal', 7.12345, 2.675],
  ['just below and exactly on a boundary', 1.00004999, 1.00005],
  ['boundary at the bottom and at the top', 0.00005, 9.99995],
  ['below the smallest step and just under the top', 0.00004999, 9.99994999],
  ['negative zero and the maximum', -0, 10],
];

describe.each(testDatabaseTargets())(
  'score precision through the pipeline on %s',
  (_name, open) => {
    let database: TestDatabase;
    let db: JudgeDatabase;
    beforeAll(async () => {
      database = await open();
      db = database.db;
    });
    afterAll(async () => {
      await database.close();
    });

    /** An assessor that gives `first` to the first dimension and `second` to the other, citing project evidence. */
    function scoring(first: number, second: number): FakeModel {
      return new FakeModel().on('dimension_assessment', (ctx) => {
        const { dimensionId } = unitOf(ctx);
        const project = candidateHandles(ctx).filter(
          (h) => ctx.byHandle.get(h)?.meta['authorship'] !== 'event_reference',
        );
        return {
          dimensionId,
          outcome: { kind: 'scored', score: dimensionId.endsWith('problem_fit') ? first : second },
          citations: project.slice(0, 2).map((evidence) => ({
            evidence,
            directness: 'direct',
            specificity: 'exact',
            note: 'cited as shown',
          })),
          rationale: 'Supported by the cited records.',
          limitations: [],
        };
      });
    }

    async function seed(model: FakeModel) {
      const run = await execute(db, { model });
      expect(run.outcome.kind).toBe('succeeded');
      const [assessment] = await run.assessments();
      const reads = new AssessmentReadStore(db);
      return { run, id: assessment?.id ?? '', projectId: run.world.project.id, reads };
    }

    async function rawScores(id: string): Promise<Record<string, number | null>> {
      const rows = await db
        .select()
        .from(assessmentDimensionJudgments)
        .where(eq(assessmentDimensionJudgments.assessmentId, id));
      return Object.fromEntries(rows.map((row) => [row.dimensionId, row.score]));
    }

    describe('legitimate assessments verify and show the report-level score', () => {
      it.each(PAIRS)('%s', async (_label, first, second) => {
        const { id, projectId, reads } = await seed(scoring(first, second));
        // the row keeps the RAW value (the writer is unchanged: this is also what every pre-fix, "legacy", row looks like)
        const raw = await rawScores(id);
        // `===` on purpose: the database may return +0 for a stored -0, which is the same score
        expect(raw['official.problem_fit'] === first).toBe(true);
        expect(raw['official.usability'] === second).toBe(true);

        const detail = await reads.getDetail(projectId, id);
        expect(detail).toMatchObject({ verified: true, verificationFailure: null });
        const byId = new Map(detail?.judgments.map((j) => [j.dimensionId, j]));
        const expectedFirst = canonicalReportedScore(first);
        const expectedSecond = canonicalReportedScore(second);
        expect(byId.get('official.problem_fit')?.score).toBe(expectedFirst);
        expect(byId.get('official.usability')?.score).toBe(expectedSecond);
        // the report is the source of the displayed numbers
        const reportScores = Object.fromEntries(
          (detail?.report?.dimensions ?? []).map((d) => [
            d.id,
            d.state === 'assessed' ? d.scoreOnScale : null,
          ]),
        );
        expect(reportScores).toEqual({
          'official.problem_fit': expectedFirst,
          'official.usability': expectedSecond,
        });
        // never negative zero, whatever the raw value was
        for (const judgment of detail?.judgments ?? []) {
          expect(Object.is(judgment.score, -0)).toBe(false);
        }
        expect((await reads.list(projectId))[0]).toMatchObject({ verified: true });
      });

      it('the two R6B values are shown at four decimals (7.33333 → 7.3333, 6.666666666666667 → 6.6667)', async () => {
        const { id, projectId, reads } = await seed(scoring(7.33333, 6.666666666666667));
        const detail = await reads.getDetail(projectId, id);
        expect(detail?.judgments.map((j) => j.score)).toEqual([7.3333, 6.6667]);
      });

      it('a partial assessment with fractional scores verifies; the insufficient dimension stays null, never zero', async () => {
        const model = new FakeModel().on('dimension_assessment', (ctx) => {
          const { dimensionId } = unitOf(ctx);
          if (dimensionId.endsWith('hard_part')) return insufficient(dimensionId);
          const project = candidateHandles(ctx).filter(
            (h) => ctx.byHandle.get(h)?.meta['authorship'] !== 'event_reference',
          );
          return {
            dimensionId,
            outcome: {
              kind: 'scored',
              score: dimensionId.endsWith('idea') ? 7.33333 : 6.666666666666667,
            },
            citations: project.slice(0, 2).map((evidence) => ({
              evidence,
              directness: 'direct',
              specificity: 'exact',
              note: 'ok',
            })),
            rationale: 'Supported by the cited records.',
            limitations: [],
          };
        });
        const run = await execute(db, {
          model,
          worldOptions: {
            criterionList: [
              { key: 'idea', weight: 0.4, anchors: [] },
              { key: 'execution', weight: 0.3, anchors: [] },
              { key: 'hard_part', weight: 0.3, anchors: [] },
            ],
          },
        });
        expect(run.outcome.kind).toBe('succeeded');
        const [assessment] = await run.assessments();
        const reads = new AssessmentReadStore(db);
        const detail = await reads.getDetail(run.world.project.id, assessment?.id ?? '');
        expect(detail).toMatchObject({ verified: true });
        expect(detail?.report?.overall).toMatchObject({
          state: 'scored_partial',
          assessedWeightShare: 0.7,
          missingCriterionKeys: ['hard_part'],
        });
        const scores = Object.fromEntries(
          (detail?.judgments ?? []).map((j) => [j.dimensionId, j.score]),
        );
        expect(scores).toEqual({
          'official.idea': 7.3333,
          'official.execution': 6.6667,
          'official.hard_part': null,
        });
        expect(Object.values(scores).filter((value) => value === 0)).toEqual([]);
      });
    });

    describe('tampering with the stored raw scores', () => {
      async function tamper(id: string, value: string) {
        await withGuardsDisabled(
          db,
          ['judgments'],
          [
            sql`UPDATE assessment_dimension_judgments SET score = ${sql.raw(value)} WHERE assessment_id = ${id} AND dimension_id = 'official.problem_fit'`,
          ],
        );
      }

      it.each([
        ['a material change (7.33333 → 1)', '1'],
        ['the next canonical bucket (7.33333 → 7.33335 = 7.3334)', '7.33335'],
        ['one canonical step (7.33333 → 7.3334)', '7.3334'],
        ['a zero where a number was judged', '0'],
        ['the maximum', '10'],
        ['NaN', "'NaN'::float8"],
        ['+Infinity', "'Infinity'::float8"],
        ['-Infinity', "'-Infinity'::float8"],
      ])('fails closed: %s', async (_label, value) => {
        const { id, projectId, reads } = await seed(scoring(7.33333, 6.666666666666667));
        await tamper(id, value);
        const detail = await reads.getDetail(projectId, id);
        expect(detail).toMatchObject({
          verified: false,
          verificationFailure: 'judgment_mismatch_score',
          report: null,
          judgments: [],
          limitations: [],
        });
        expect((await reads.list(projectId))[0]).toMatchObject({ verified: false, overall: null });
      });

      it.each([
        ['7.33333 → 7.33334', '7.33334'],
        ['7.33333 → 7.333300001', '7.333300001'],
        [
          '7.33333 → 7.33326 (the lowest value of the bucket 7.3333 ± 0.00005, exclusive)',
          '7.33326',
        ],
      ])(
        'DOCUMENTED EQUIVALENCE CLASS: a change inside the same four-decimal bucket is NOT detected (%s); the displayed score is still the report’s 7.3333',
        async (_label, value) => {
          const { id, projectId, reads } = await seed(scoring(7.33333, 6.666666666666667));
          await tamper(id, value);
          const detail = await reads.getDetail(projectId, id);
          expect(detail).toMatchObject({ verified: true });
          expect(
            detail?.judgments.find((j) => j.dimensionId === 'official.problem_fit')?.score,
          ).toBe(7.3333);
          // the raw tampered value is never returned
          expect(JSON.stringify(detail)).not.toContain(value);
        },
      );
    });
  },
);
