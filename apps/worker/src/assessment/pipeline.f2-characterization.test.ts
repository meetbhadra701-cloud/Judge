import {
  assessmentDimensionJudgments,
  preInterviewAssessments,
  type JudgeDatabase,
} from '@judge-copilot/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidateHandles, FakeModel, insufficient, unitOf } from '../testing/fake-model.js';
import { testDatabaseTargets, type TestDatabase } from '../testing/harness.js';
import { execute } from '../testing/run.js';

/*
 * R5 F-2 CHARACTERIZATION (P6A). These tests pin the CURRENT behavior that `docs/milestones/M5-P6A-decisions.md` (F-2) asks the owner to
 * decide about: the critic reviews only SCORED judgments, so a dimension the assessor declares insufficient is never reviewed, and
 * M4 renormalizes the remaining weight. Nothing here changes behavior and nothing here is a defect of the M4 formulas; the
 * `it.todo` entries name the regression tests the approved correction would add. If the correction is approved, the assertions marked
 * "CURRENT" are the ones that flip.
 */

describe.each(testDatabaseTargets())('F-2: model-declared insufficiency on %s', (_name, open) => {
  let database: TestDatabase;
  let db: JudgeDatabase;
  beforeAll(async () => {
    database = await open();
    db = database.db;
  });
  afterAll(async () => {
    await database.close();
  });

  async function runThreeCriteria(hardPart: 'insufficient' | 'scored-low') {
    const model = new FakeModel();
    model.on('dimension_assessment', (ctx) => {
      const { dimensionId, scale } = unitOf(ctx);
      if (dimensionId.endsWith('hard_part') && hardPart === 'insufficient') {
        return insufficient(dimensionId);
      }
      const project = candidateHandles(ctx).filter(
        (h) => ctx.byHandle.get(h)?.meta['authorship'] !== 'event_reference',
      );
      const score = dimensionId.endsWith('hard_part') ? 2 : 9;
      return {
        dimensionId,
        outcome: { kind: 'scored', score: scale.min + (score / 10) * (scale.max - scale.min) },
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
    const [assessment] = await db
      .select()
      .from(preInterviewAssessments)
      .where(eq(preInterviewAssessments.runId, run.runId));
    const judgments = await db
      .select()
      .from(assessmentDimensionJudgments)
      .where(eq(assessmentDimensionJudgments.assessmentId, assessment?.id ?? ''));
    return {
      model,
      report: assessment?.report as {
        overall: {
          state: string;
          score10?: number;
          assessedWeightShare: number;
          missingCriterionKeys: string[];
        };
      },
      limitations: (assessment?.limitations as { code: string }[]).map((l) => l.code),
      limitationSubjects:
        (assessment?.limitations as { code: string; subjects: string[] }[]).find(
          (l) => l.code === 'partial_score_excludes_model_declared_insufficient',
        )?.subjects ?? [],
      judgments,
    };
  }

  it('CURRENT: 9 / 9 / "insufficient" is reported as scored_partial 9.0 over 70% of the weight, and the insufficiency was never reviewed', async () => {
    const insufficientRun = await runThreeCriteria('insufficient');
    expect(insufficientRun.report.overall).toMatchObject({
      state: 'scored_partial',
      score10: 9,
      assessedWeightShare: 0.7,
      missingCriterionKeys: ['hard_part'],
    });
    // CURRENT: no critic call exists for the insufficient unit, and nothing marks the exclusion as model-declared
    expect(
      insufficientRun.model.callsOf('critic').filter((c) => c.dimensionId?.endsWith('hard_part')),
    ).toHaveLength(0);
    const hard = insufficientRun.judgments.find((j) => j.dimensionId.endsWith('hard_part'));
    expect(hard).toMatchObject({
      disposition: 'assessor_reported_insufficient',
      criticReviewed: false,
      criticReviewRequired: false,
    });
    // P6C (F-2 option B): the exclusion is attributed to the assessor's own unreviewed claim; the number above is unchanged
    expect(insufficientRun.limitations).toContain(
      'partial_score_excludes_model_declared_insufficient',
    );
    expect(insufficientRun.limitationSubjects).toEqual([hard?.dimensionId]);
  });

  it('the same project with the third criterion scored 2 is 6.9: the partial number is not "the score of the whole rubric"', async () => {
    const scoredRun = await runThreeCriteria('scored-low');
    expect(scoredRun.report.overall).toMatchObject({ state: 'scored', score10: 6.9 });
    // P6C: a fully scored run carries no model-declared-exclusion limitation
    expect(scoredRun.limitations).not.toContain(
      'partial_score_excludes_model_declared_insufficient',
    );
  });

  it.todo(
    'APPROVED CHANGE (F-2 option A, needs critic prompt v2): an assessor-reported insufficiency over a substantial project-derived candidate set is reviewed once; a contested insufficiency triggers the bounded re-run',
  );
  it.todo(
    'INVARIANT: no change touches packages/scoring, its goldens or the report hash (the 9.0 and 6.9 above stay exactly as M4 computes them)',
  );
});
