import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import {
  AssessmentReadStore,
  assessmentDimensionJudgments,
  preInterviewAssessments,
  type JudgeDatabase,
} from '@judge-copilot/database';
import type { AssessmentDetail } from '@judge-copilot/schemas';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withGuardsDisabled } from '../testing/corrupt.js';
import { candidateHandles, FakeModel, insufficient, unitOf } from '../testing/fake-model.js';
import { testDatabaseTargets, type TestDatabase } from '../testing/harness.js';
import { execute } from '../testing/run.js';

/*
 * P6A-R1: the permanent form of the R6A attacks on the READ MODEL. Each test builds a real assessment through the real pipeline on a
 * DISPOSABLE database, corrupts a stored row the way a hostile or buggy writer could (the immutability trigger is disabled for that one
 * statement by `withGuardsDisabled`, a test-only helper), and checks the invariant:
 *
 *   an assessment that does not verify exposes NO report, NO number of any kind (score, score10, scoreOnScale, ...), NO rationale,
 *   NO limitation and NO citation or evidence text; it exposes only safe metadata and a stable failure code.
 *
 * Runs on PGlite and on PostgreSQL 16.
 */

type Seed = {
  readonly projectId: string;
  readonly id: string;
  readonly reads: AssessmentReadStore;
  readonly good: AssessmentDetail;
  readonly world: Awaited<ReturnType<typeof execute>>['world'];
};

const WITHHELD_KEYS = ['"score"', '"score10"', '"scoreOnScale"', '"rationale"', '"excerpt"'];

describe.each(testDatabaseTargets())('read model: hostile stored data on %s', (_name, open) => {
  let database: TestDatabase;
  let db: JudgeDatabase;
  beforeAll(async () => {
    database = await open();
    db = database.db;
  });
  afterAll(async () => {
    await database.close();
  });

  /** A fully scored assessment (two dimensions at 7). */
  async function seedScored(): Promise<Seed> {
    const run = await execute(db);
    expect(run.outcome.kind).toBe('succeeded');
    return seedFrom(run);
  }

  async function seedFrom(run: Awaited<ReturnType<typeof execute>>): Promise<Seed> {
    const [assessment] = await run.assessments();
    const reads = new AssessmentReadStore(db);
    const projectId = run.world.project.id;
    const id = assessment?.id ?? '';
    const good = await reads.getDetail(projectId, id);
    if (good === null) throw new Error('the seeded assessment is not readable');
    expect(good.verified).toBe(true);
    return { projectId, id, reads, good, world: run.world };
  }

  /** Three weighted criteria (0.4/0.3/0.3); the third is declared insufficient by the assessor or scored 2. */
  async function seedThree(hardPart: 'insufficient' | 'scored-low'): Promise<Seed> {
    const model = new FakeModel();
    model.on('dimension_assessment', (ctx) => {
      const { dimensionId, scale } = unitOf(ctx);
      const hard = dimensionId.endsWith('hard_part');
      if (hard && hardPart === 'insufficient') return insufficient(dimensionId);
      const project = candidateHandles(ctx).filter(
        (h) => ctx.byHandle.get(h)?.meta['authorship'] !== 'event_reference',
      );
      return {
        dimensionId,
        outcome: {
          kind: 'scored',
          score: scale.min + ((hard ? 2 : 9) / 10) * (scale.max - scale.min),
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
    return seedFrom(run);
  }

  /** The assessor declares every dimension insufficient: the overall is insufficient too. */
  async function seedAllInsufficient(): Promise<Seed> {
    const model = new FakeModel().on('dimension_assessment', (ctx) =>
      insufficient(unitOf(ctx).dimensionId),
    );
    const run = await execute(db, { model });
    expect(run.outcome.kind).toBe('succeeded');
    return seedFrom(run);
  }

  /** The strings of a verified detail that must never appear once the assessment is withheld. */
  function sensitiveStrings(good: AssessmentDetail): string[] {
    // very short strings (a note of "ok") would match unrelated JSON; the long ones are the ones that carry content
    return [
      ...good.judgments.flatMap((j) => (j.rationale ? [j.rationale] : [])),
      ...good.judgments.flatMap((j) => j.citations.flatMap((c) => (c.note ? [c.note] : []))),
      ...good.judgments.flatMap((j) =>
        j.citations.flatMap((c) => (c.evidence ? [c.evidence.text] : [])),
      ),
    ].filter((value) => value.length >= 12);
  }

  async function expectWithheld(seed: Seed, failure: string | RegExp) {
    const detail = await seed.reads.getDetail(seed.projectId, seed.id);
    expect(detail).not.toBeNull();
    expect(detail).toMatchObject({
      id: seed.id,
      projectId: seed.projectId,
      versionNumber: seed.good.versionNumber,
      verified: false,
      report: null,
      judgments: [],
      limitations: [],
    });
    if (typeof failure === 'string') expect(detail?.verificationFailure).toBe(failure);
    else expect(detail?.verificationFailure).toMatch(failure);
    const text = JSON.stringify(detail);
    for (const key of WITHHELD_KEYS) expect(text, key).not.toContain(key);
    const sensitive = sensitiveStrings(seed.good);
    expect(sensitive.length).toBeGreaterThan(0);
    for (const value of sensitive) expect(text).not.toContain(value);
    // safe metadata is still there: the assessment exists, and why it is withheld
    expect(detail?.providerMode).toBe(seed.good.providerMode);
    expect(detail?.pipeline).toEqual(seed.good.pipeline);
    const listed = (await seed.reads.list(seed.projectId)).find((item) => item.id === seed.id);
    expect(listed).toMatchObject({
      verified: false,
      overall: null,
      versionNumber: seed.good.versionNumber,
    });
    expect(JSON.stringify(listed)).not.toContain('score');
  }

  describe('step 1: the stored report bytes', () => {
    it('a corrupted JSONB mirror withholds everything (before the fix: verified=false but every judgment score and text was returned)', async () => {
      const seed = await seedScored();
      await withGuardsDisabled(
        db,
        ['assessments'],
        [
          sql`UPDATE pre_interview_assessments SET report = jsonb_set(report, '{overall,score10}', '10') WHERE id = ${seed.id}`,
        ],
      );
      await expectWithheld(seed, 'jsonb_mirror');
    });

    it('altered canonical report text withholds everything (text hash no longer matches)', async () => {
      const seed = await seedScored();
      await withGuardsDisabled(
        db,
        ['assessments'],
        [
          sql`UPDATE pre_interview_assessments SET report_canonical = replace(report_canonical, '"score10":7', '"score10":9') WHERE id = ${seed.id}`,
        ],
      );
      await expectWithheld(seed, 'text_hash');
    });

    it('a broken text hash withholds everything', async () => {
      const seed = await seedScored();
      await withGuardsDisabled(
        db,
        ['assessments'],
        [
          sql`UPDATE pre_interview_assessments SET report_text_sha256 = repeat('0', 64) WHERE id = ${seed.id}`,
        ],
      );
      await expectWithheld(seed, 'text_hash');
    });

    it('a schema-invalid report whose text hash and mirror were made consistent is still withheld', async () => {
      const seed = await seedScored();
      const [row] = await db
        .select()
        .from(preInterviewAssessments)
        .where(eq(preInterviewAssessments.id, seed.id));
      const broken = JSON.parse(row?.reportCanonical ?? '{}') as Record<string, unknown>;
      delete broken['notices']; // a required key
      const text = canonicalJson(broken);
      await withGuardsDisabled(
        db,
        ['assessments'],
        [
          sql`UPDATE pre_interview_assessments SET report_canonical = ${text}, report_text_sha256 = ${sha256Hex(text)}, report = ${text}::jsonb WHERE id = ${seed.id}`,
        ],
      );
      await expectWithheld(seed, 'schema');
    });

    it('a body changed with every hash recomputed except the M4 output hash is withheld', async () => {
      const seed = await seedScored();
      const [row] = await db
        .select()
        .from(preInterviewAssessments)
        .where(eq(preInterviewAssessments.id, seed.id));
      const changed = JSON.parse(row?.reportCanonical ?? '{}') as {
        overall: { score10: number };
      };
      changed.overall.score10 = 10;
      const text = canonicalJson(changed);
      await withGuardsDisabled(
        db,
        ['assessments'],
        [
          sql`UPDATE pre_interview_assessments SET report_canonical = ${text}, report_text_sha256 = ${sha256Hex(text)}, report = ${text}::jsonb WHERE id = ${seed.id}`,
        ],
      );
      await expectWithheld(seed, 'output_hash');
    });
  });

  describe('step 2: the judgment rows against the verified report', () => {
    it('a modified judgment score while the report stays valid withholds everything, never a contradictory pair of numbers', async () => {
      const seed = await seedScored();
      expect(seed.good.judgments.map((j) => j.score)).toEqual([7, 7]);
      await withGuardsDisabled(
        db,
        ['judgments'],
        [sql`UPDATE assessment_dimension_judgments SET score = 1 WHERE assessment_id = ${seed.id}`],
      );
      await expectWithheld(seed, 'judgment_mismatch_score');
    });

    it('a scored judgment flipped to insufficient while the report says assessed is withheld', async () => {
      const seed = await seedScored();
      await withGuardsDisabled(
        db,
        ['judgments'],
        [
          sql`UPDATE assessment_dimension_judgments SET outcome_kind = 'insufficient_evidence', score = NULL, disposition = 'assessor_reported_insufficient' WHERE assessment_id = ${seed.id}`,
        ],
      );
      await expectWithheld(seed, 'judgment_mismatch_outcome_state');
    });

    it('a judgment row that claims a number for an insufficient dimension is withheld, and never shown as zero', async () => {
      const seed = await seedThree('insufficient');
      const hard = seed.good.judgments.find((j) => j.dimensionId.endsWith('hard_part'));
      expect(hard?.score).toBeNull();
      await withGuardsDisabled(
        db,
        ['judgments'],
        [
          sql`UPDATE assessment_dimension_judgments SET outcome_kind = 'scored', score = 0, disposition = 'scored' WHERE assessment_id = ${seed.id} AND dimension_id LIKE '%hard_part'`,
        ],
      );
      await expectWithheld(seed, 'judgment_mismatch_outcome_state');
    });

    it('a deleted judgment row (a dimension of the report without a judgment) is withheld', async () => {
      const seed = await seedScored();
      const first = seed.good.judgments[0]?.dimensionId ?? '';
      await withGuardsDisabled(
        db,
        ['judgments', 'citations'],
        [
          sql`DELETE FROM assessment_judgment_citations WHERE assessment_id = ${seed.id} AND dimension_id = ${first}`,
          sql`DELETE FROM assessment_dimension_judgments WHERE assessment_id = ${seed.id} AND dimension_id = ${first}`,
        ],
      );
      await expectWithheld(seed, 'judgment_mismatch_dimension_set');
    });

    it('a deleted citation row (the row cites less than the scorer was given) is withheld', async () => {
      const seed = await seedScored();
      await withGuardsDisabled(
        db,
        ['citations'],
        [
          sql`DELETE FROM assessment_judgment_citations WHERE assessment_id = ${seed.id} AND position = (SELECT min(position) FROM assessment_judgment_citations WHERE assessment_id = ${seed.id})`,
        ],
      );
      await expectWithheld(seed, 'judgment_mismatch_citations');
    });
  });

  describe('what is still readable, and what is NOT authenticated', () => {
    it('a legitimately scored assessment is fully readable, with every number taken from the verified report', async () => {
      const seed = await seedScored();
      const detail = seed.good;
      expect(detail).toMatchObject({ verified: true, verificationFailure: null });
      expect(detail.report?.overall).toMatchObject({ state: 'scored', score10: 7 });
      expect(detail.judgments).toHaveLength(2);
      for (const judgment of detail.judgments) {
        expect(judgment).toMatchObject({
          outcomeKind: 'scored',
          score: 7,
          dispositionAttribution: 'scored',
          semanticRelevance: 'not_verified',
        });
        expect(judgment.rationale).not.toBeNull();
        expect(judgment.citations.length).toBeGreaterThan(0);
      }
      const listed = (await seed.reads.list(seed.projectId))[0];
      expect(listed).toMatchObject({ verified: true, overall: { state: 'scored', score10: 7 } });
    });

    it('a partial assessment keeps its weight and missing-dimension semantics; the missing dimension has null, never zero', async () => {
      const seed = await seedThree('insufficient');
      const detail = seed.good;
      expect(detail.report?.overall).toMatchObject({
        state: 'scored_partial',
        score10: 9,
        assessedWeightShare: 0.7,
        missingCriterionKeys: ['hard_part'],
      });
      const hard = detail.judgments.find((j) => j.dimensionId.endsWith('hard_part'));
      expect(hard).toMatchObject({
        outcomeKind: 'insufficient_evidence',
        score: null,
        dispositionAttribution: 'insufficient_by_assessor',
      });
      expect(detail.judgments.filter((j) => j.score === 0)).toEqual([]);
      const dimension = detail.report?.dimensions.find((d) => d.id.endsWith('hard_part'));
      expect(dimension?.state).toBe('insufficient_evidence');
      expect(JSON.stringify(dimension)).not.toContain('score');
      expect((await seed.reads.list(seed.projectId))[0]?.overall).toEqual({
        state: 'scored_partial',
        score10: 9,
      });
    });

    it('an overall that is insufficient has no number at any level', async () => {
      const seed = await seedAllInsufficient();
      expect(seed.good.report?.overall.state).toBe('insufficient_evidence');
      expect(seed.good.judgments.every((j) => j.score === null)).toBe(true);
      expect(JSON.stringify(seed.good.report?.overall)).not.toContain('score');
      expect((await seed.reads.list(seed.projectId))[0]?.overall).toEqual({
        state: 'insufficient_evidence',
        score10: null,
      });
    });

    it('an assessment of another project is indistinguishable from a missing one (detail null, list empty)', async () => {
      const seed = await seedScored();
      const other = await execute(db); // another world, another project
      const otherProject = other.world.project.id;
      expect(await seed.reads.getDetail(otherProject, seed.id)).toBeNull();
      expect(await seed.reads.getRun(otherProject, seed.good.runId)).toBeNull();
      expect((await seed.reads.list(otherProject)).map((item) => item.id)).not.toContain(seed.id);
      expect(
        await seed.reads.getDetail(seed.projectId, '5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e'),
      ).toBeNull();
    });

    it('DOCUMENTED LIMIT: the free text of a verified assessment (rationale) is not covered by any hash; a changed rationale is still returned, and the contract says so', async () => {
      const seed = await seedScored();
      await withGuardsDisabled(
        db,
        ['judgments'],
        [
          sql`UPDATE assessment_dimension_judgments SET rationale = 'rewritten text' WHERE assessment_id = ${seed.id}`,
        ],
      );
      const detail = await seed.reads.getDetail(seed.projectId, seed.id);
      // numbers, state and citations still agree with the verified report, so the assessment stays readable; only the text differs
      expect(detail?.verified).toBe(true);
      expect(detail?.judgments.every((j) => j.rationale === 'rewritten text')).toBe(true);
      expect(detail?.report?.overall).toMatchObject({ score10: 7 });
    });

    it('a corrupted version does not hide the good one: the list reports each version with its own verification', async () => {
      const first = await seedScored();
      const second = await seedFrom(
        await execute(db, { world: first.world, model: new FakeModel(), mode: 'reassess' }),
      );
      expect(second.good.versionNumber).toBe(first.good.versionNumber + 1);
      await withGuardsDisabled(
        db,
        ['judgments'],
        [
          sql`UPDATE assessment_dimension_judgments SET score = 1 WHERE assessment_id = ${first.id}`,
        ],
      );
      const listed = await first.reads.list(first.projectId);
      expect(listed.find((item) => item.id === first.id)).toMatchObject({
        verified: false,
        overall: null,
      });
      expect(listed.find((item) => item.id === second.id)).toMatchObject({
        verified: true,
        overall: { state: 'scored', score10: 7 },
      });
      // reading never alters the immutable history
      const rows = await db
        .select({ score: assessmentDimensionJudgments.score })
        .from(assessmentDimensionJudgments)
        .where(eq(assessmentDimensionJudgments.assessmentId, first.id));
      expect(rows.map((row) => row.score)).toEqual([1, 1]);
    });
  });
});
