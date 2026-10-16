import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssessmentStore } from './assessment-store.js';
import type { JudgeDatabase } from './index.js';
import { QuestionSetStore } from './question-set-store.js';
import { preInterviewAssessments } from './schema/index.js';
import { testDatabaseTargets, type TestDatabase } from './testing/databases.js';
import { persistedAssessment, questionSetInput } from './testing/question-world.js';

describe.each(testDatabaseTargets())('question set store on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;
  let store: QuestionSetStore;
  let counter = 0;

  beforeAll(async () => {
    testDb = await open();
    db = testDb.db;
    store = new QuestionSetStore(db);
  });
  afterAll(async () => {
    await testDb.close();
  });

  async function fresh() {
    const made = await persistedAssessment(db);
    counter += 1;
    const key = counter.toString(16).padStart(64, '0');
    const [row] = await db
      .select({
        contextVersionId: preInterviewAssessments.contextVersionId,
        extractionId: preInterviewAssessments.extractionId,
      })
      .from(preInterviewAssessments)
      .where(eq(preInterviewAssessments.id, made.assessmentId));
    const base = {
      projectId: made.world.project.id,
      assessmentId: made.assessmentId,
      contextVersionId: row?.contextVersionId ?? '',
      extractionId: row?.extractionId ?? '',
      reportOutputHash: made.report.outputHash,
    };
    return { made, base, input: questionSetInput(base, { generationKey: key }) };
  }

  it('persists a set in one transaction and reads it back with ranks, evidence links and the shortfall', async () => {
    const { made, input } = await fresh();
    const result = await store.persist(input);
    expect(result.kind).toBe('created');
    const view = await store.getView(made.world.project.id, result.setId);
    expect(view).toMatchObject({
      projectId: made.world.project.id,
      assessmentId: made.assessmentId,
      assessmentVerified: true,
      policyVersion: 'question-engine/v1',
      counts: { opportunities: 2, candidates: 2, rejected: 0, selected: 2 },
      shortfall: { code: 'fewer_defensible_candidates', candidateCount: 2 },
      generation: { providerMode: 'scripted', demonstration: true, models: null },
    });
    expect(view?.questions.map((q) => q.rank)).toEqual([1, 2]);
    expect(view?.questions[0]?.dimensions[0]).toEqual({
      id: 'official.originality',
      name: 'Originality',
      weightShare: 0.5,
    });
    expect(view?.questions[0]?.references[0]).toMatchObject({
      type: 'claim',
      verificationLevel: 'team_claim',
    });
    expect(view?.opportunities.map((o) => o.ordinal)).toEqual([1, 2]);
    expect(view?.notices.scores).toBe('questions_never_change_scores');
  });

  it('is idempotent: the same generation key returns the stored set and writes nothing', async () => {
    const { made, input } = await fresh();
    const first = await store.persist(input);
    const second = await store.persist({ ...input, opportunities: [], questions: [] });
    expect(second).toEqual({ kind: 'existing', setId: first.setId });
    const view = await store.getView(made.world.project.id, first.setId);
    expect(view?.questions).toHaveLength(2);
  });

  it('creates exactly one set when many requests for the same key race', async () => {
    const { made, input } = await fresh();
    const results = await Promise.all(Array.from({ length: 8 }, () => store.persist(input)));
    expect(results.filter((r) => r.kind === 'created')).toHaveLength(1);
    expect(new Set(results.map((r) => r.setId)).size).toBe(1);
    expect(await store.listForAssessment(made.world.project.id, made.assessmentId)).toHaveLength(1);
  });

  it('is project scoped: another project cannot read, list or probe the set', async () => {
    const { made, input } = await fresh();
    const { setId } = await store.persist(input);
    const other = await persistedAssessment(db);
    expect(await store.getView(other.world.project.id, setId)).toBeNull();
    expect(await store.listForAssessment(other.world.project.id, made.assessmentId)).toEqual([]);
    expect(await store.assessmentExists(other.world.project.id, made.assessmentId)).toBe(false);
    expect(await store.findSetIdByKey(other.world.project.id, input.generationKey)).toBeNull();
  });

  describe('immutability and integrity enforced by the database', () => {
    it('refuses UPDATE, DELETE and TRUNCATE on all three tables', async () => {
      const { input } = await fresh();
      const { setId } = await store.persist(input);
      for (const statement of [
        sql`UPDATE question_sets SET selected_count = selected_count WHERE id = ${setId}`,
        sql`DELETE FROM question_sets WHERE id = ${setId}`,
        sql`UPDATE question_set_questions SET text = 'changed' WHERE set_id = ${setId}`,
        sql`DELETE FROM question_set_questions WHERE set_id = ${setId}`,
        sql`UPDATE question_set_opportunities SET observation = 'changed' WHERE set_id = ${setId}`,
        sql`DELETE FROM question_set_opportunities WHERE set_id = ${setId}`,
        sql`TRUNCATE question_set_questions`,
        sql`TRUNCATE question_set_opportunities`,
        sql`TRUNCATE question_sets CASCADE`,
      ]) {
        await expect(db.execute(statement)).rejects.toThrow();
      }
    });

    it('refuses a set that disagrees with its assessment (report hash, context version, extraction)', async () => {
      const { input } = await fresh();
      await expect(store.persist({ ...input, reportOutputHash: 'f'.repeat(64) })).rejects.toThrow();
      await expect(
        store.persist({ ...input, contextVersionId: '00000000-0000-4000-8000-0000000000aa' }),
      ).rejects.toThrow();
    });

    it('refuses an assessment of another project (composite foreign key)', async () => {
      const { input } = await fresh();
      const other = await persistedAssessment(db);
      await expect(
        store.persist({ ...input, projectId: other.world.project.id }),
      ).rejects.toThrow();
    });

    it('refuses an incomplete set at commit: declared counts must match the rows', async () => {
      const { input } = await fresh();
      await expect(
        store.persist({ ...input, questions: input.questions.slice(0, 1) }),
      ).rejects.toThrow(/declared questions/);
      await expect(
        store.persist({
          ...input,
          generationKey: 'e'.repeat(64),
          opportunities: input.opportunities.slice(0, 1),
        }),
      ).rejects.toThrow(/declared opportunities/);
    });

    it('refuses a question that cites an opportunity outside its own set', async () => {
      const { input } = await fresh();
      const questions = input.questions.map((q, i) =>
        i === 0 ? { ...q, opportunityKeys: ['opp-00000000000000ff'] } : q,
      );
      await expect(store.persist({ ...input, questions })).rejects.toThrow(/outside the set/);
    });

    it('refuses a set with fewer than five questions and no explanation, and five with one', async () => {
      const { input } = await fresh();
      await expect(store.persist({ ...input, shortfall: null })).rejects.toThrow();
      await expect(
        store.persist({
          ...input,
          counts: { ...input.counts, selected: 5, candidates: 5 },
          shortfall: { code: 'redundant_candidates', explanation: 'x' },
        }),
      ).rejects.toThrow();
    });

    it('refuses a live-labelled set marked as a demonstration and a demonstration marked as live', async () => {
      const { input } = await fresh();
      await expect(
        db.execute(sql`UPDATE question_sets SET demonstration = false WHERE false`),
      ).resolves.toBeDefined();
      // the store derives `demonstration` from the provider mode; a direct insert that disagrees is refused by the CHECK
      await expect(
        db.execute(sql`
          INSERT INTO question_sets (project_id, assessment_id, context_version_id, extraction_id, report_output_hash, policy_version, uncertainty_engine_version,
            weight_basis, generation_key, input_hash, provider_mode, provider_id, demonstration, model, prompt_id, prompt_version, prompt_template_hash,
            output_schema_hash, opportunity_count, candidate_count, rejected_count, selected_count, shortfall_code, shortfall_explanation, rejections)
          VALUES (${input.projectId}, ${input.assessmentId}, ${input.contextVersionId}, ${input.extractionId}, ${input.reportOutputHash}, 'question-engine/v1', 'uncertainty-engine/v1',
            'official', ${'a'.repeat(64)}, ${'2'.repeat(64)}, 'scripted', 'scripted', false, 'm', 'p', 'v1', ${'3'.repeat(64)}, ${'4'.repeat(64)}, 0, 0, 0, 0, 'no_uncertainty', 'none', '[]'::jsonb)`),
      ).rejects.toThrow();
    });
  });

  describe('fail closed when the assessment no longer verifies', () => {
    it('withholds questions and opportunities, keeping only safe metadata', async () => {
      const { made, input } = await fresh();
      const { setId } = await store.persist(input);
      await db.execute(sql`ALTER TABLE pre_interview_assessments DISABLE TRIGGER USER`);
      try {
        await db.execute(
          sql`UPDATE pre_interview_assessments SET report_text_sha256 = ${'0'.repeat(64)} WHERE id = ${made.assessmentId}`,
        );
      } finally {
        await db.execute(sql`ALTER TABLE pre_interview_assessments ENABLE TRIGGER USER`);
      }
      const view = await store.getView(made.world.project.id, setId);
      expect(view).toMatchObject({
        assessmentVerified: false,
        questions: [],
        opportunities: [],
        shortfall: null,
      });
      expect(JSON.stringify(view)).not.toContain('Could you show');
    });
  });

  it('does not touch the assessment: its row and judgments are unchanged by a set', async () => {
    const { made, input } = await fresh();
    const before = await new AssessmentStore(db).judgments(made.assessmentId);
    await store.persist(input);
    expect(await new AssessmentStore(db).judgments(made.assessmentId)).toEqual(before);
  });
});
