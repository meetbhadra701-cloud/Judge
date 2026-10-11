import { assessmentDimensionJudgments, type JudgeDatabase } from '@judge-copilot/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  blocking,
  candidateHandles,
  FakeModel,
  parseRecords,
  unitOf,
  type Context,
} from '../testing/fake-model.js';
import { testDatabaseTargets, type TestDatabase } from '../testing/harness.js';
import { execute, expectNoAssessment, type Executed } from '../testing/run.js';

const weights = [0.3, 0.2, 0.2, 0.2, 0.1];
const FIVE = weights.map((weight, index) => ({
  key: `crit_0${String(index + 1)}`,
  weight,
  anchors:
    index === 0
      ? [
          { score: 0, description: 'Nothing.' },
          { score: 10, description: 'Everything.' },
        ]
      : [],
}));

const cited = (context: Context): string[] =>
  context.records.filter((r) => typeof r.meta['authorship'] === 'string').map((r) => r.handle);

/** A critic that reports a blocking finding for the given units (every time it is asked). */
const criticBlocking = (units: readonly string[]) =>
  new FakeModel().on('critic', (context) => {
    const { dimensionId } = unitOf(context);
    return {
      unit: dimensionId,
      findings: units.includes(dimensionId) ? [blocking(cited(context).slice(0, 1))] : [],
    };
  });

interface Overall {
  state: string;
}
const reportOf = (assessment: { report: unknown } | undefined) =>
  assessment?.report as { overall: Overall; dimensions: { id: string; state: string }[] };

describe.each(testDatabaseTargets())('the critic and its decision table on %s', (_name, open) => {
  let database: TestDatabase;
  let db: JudgeDatabase;
  beforeAll(async () => {
    database = await open();
    db = database.db;
  });
  afterAll(async () => {
    await database.close();
  });

  async function judgments(run: Executed) {
    if (run.outcome.kind !== 'succeeded') throw new Error(`run ${run.outcome.kind}`);
    const rows = await db
      .select()
      .from(assessmentDimensionJudgments)
      .where(eq(assessmentDimensionJudgments.assessmentId, run.outcome.assessmentId));
    return new Map(rows.map((row) => [row.dimensionId, row]));
  }

  it('false positives on EVERY unit: each is marked insufficient by the critic, the run still succeeds, nothing is technical', async () => {
    const all = FIVE.map((c) => `official.${c.key}`);
    const run = await execute(db, {
      worldOptions: { criterionList: FIVE },
      model: criticBlocking(all),
    });
    expect(run.outcome.kind).toBe('succeeded');
    const rows = await judgments(run);
    expect([...rows.values()].map((row) => row.disposition)).toEqual(
      Array(5).fill('marked_insufficient_by_critic'),
    );
    expect(
      [...rows.values()].every(
        (row) => row.score === null && row.outcomeKind === 'insufficient_evidence',
      ),
    ).toBe(true);
    expect([...rows.values()].every((row) => row.criticReviewed)).toBe(true);
    const [assessment] = await run.assessments();
    expect(reportOf(assessment).overall.state).toBe('insufficient_evidence');
    expect((await run.run())?.failureCategory).toBeNull();
    expect(await run.outcomeRow()).toMatchObject({ outcome: 'succeeded', failureCode: null });
    // bounded: two re-runs for an official rubric, then the cap marks the rest directly
    expect(run.model.callsOf('dimension_assessment')).toHaveLength(5 + 2);
    expect(run.model.callsOf('critic')).toHaveLength(5 + 2);
    expect(rows.get('official.crit_01')).toMatchObject({ assessorAttempts: 2, criticAttempts: 2 });
    expect(rows.get('official.crit_02')).toMatchObject({ assessorAttempts: 2, criticAttempts: 2 });
    expect(rows.get('official.crit_03')).toMatchObject({ assessorAttempts: 1, criticAttempts: 1 });
  });

  it('a false positive on 20% of the units removes only that weight: scored_partial, the others untouched', async () => {
    const run = await execute(db, {
      worldOptions: { criterionList: FIVE },
      model: criticBlocking(['official.crit_03']),
    });
    const rows = await judgments(run);
    expect(rows.get('official.crit_03')?.disposition).toBe('marked_insufficient_by_critic');
    for (const key of ['crit_01', 'crit_02', 'crit_04', 'crit_05']) {
      expect(rows.get(`official.${key}`)).toMatchObject({
        disposition: 'scored',
        score: 7,
        criticReviewed: true,
      });
    }
    const [assessment] = await run.assessments();
    expect(reportOf(assessment).overall.state).toBe('scored_partial');
  });

  it('boundary: losing 0.3 keeps the result (0.7), losing 0.3 + 0.2 does not (0.5 < 0.6): a valid outcome, not a failure', async () => {
    const keep = await execute(db, {
      worldOptions: { criterionList: FIVE },
      model: criticBlocking(['official.crit_01']),
    });
    expect(reportOf((await keep.assessments())[0]).overall.state).toBe('scored_partial');
    const lose = await execute(db, {
      worldOptions: { criterionList: FIVE },
      model: criticBlocking(['official.crit_01', 'official.crit_02']),
    });
    expect(lose.outcome.kind).toBe('succeeded');
    expect(reportOf((await lose.assessments())[0]).overall.state).toBe('insufficient_evidence');
  });

  it('never lets the critic rewrite a score: extra score / replacement fields are rejected and the unit is unavailable, not edited', async () => {
    const model = new FakeModel().on('critic', (context) => ({
      unit: unitOf(context).dimensionId,
      findings: [],
      score: 0, // the critic schema has no such field
      replacement: { outcome: { kind: 'scored', score: 1 } },
    }));
    const run = await execute(db, { worldOptions: { criterionList: FIVE }, model });
    // every unit's critic is unavailable (technical): the run FAILS, with nothing persisted, rather than accepting unreviewed scores
    expect(run.outcome).toMatchObject({ kind: 'failed', category: 'schema_validation_failed' });
    await expectNoAssessment(run, db);
    expect(run.model.callsOf('critic').length).toBeGreaterThanOrEqual(4); // two asks per unit until the threshold (T = 2)
  });

  it('minor findings never change a score or fail a run; they are disclosed', async () => {
    const model = new FakeModel().on('critic', (context) => ({
      unit: unitOf(context).dimensionId,
      findings: [
        {
          code: 'team_claim_overreliance',
          severity: 'minor',
          evidence: cited(context).slice(0, 1),
          note: 'Only team statements.',
        },
      ],
    }));
    const run = await execute(db, { model });
    const rows = await judgments(run);
    expect([...rows.values()].map((row) => row.score)).toEqual([7, 7]);
    const [assessment] = await run.assessments();
    const limitations = assessment?.limitations as { code: string; subjects: string[] }[];
    expect(limitations.find((l) => l.code === 'critic_minor_findings')?.subjects).toEqual([
      'official.problem_fit',
      'official.usability',
    ]);
  });

  it('refuses a critic that names a handle it was not shown (invalid after its single re-ask: unit unavailable)', async () => {
    const model = new FakeModel().on('critic', (context) => ({
      unit: unitOf(context).dimensionId,
      findings: [blocking(['E-099'])],
    }));
    const run = await execute(db, { worldOptions: { criterionList: FIVE }, model });
    expect(run.outcome).toMatchObject({ kind: 'failed', category: 'domain_validation_failed' });
    await expectNoAssessment(run, db);
  });

  it('treats a critic that stays unavailable on ONE unit of five as technical but within the threshold', async () => {
    const model = new FakeModel().on('critic', (context) => {
      const { dimensionId } = unitOf(context);
      return dimensionId === 'official.crit_04'
        ? 'not even an object'
        : { unit: dimensionId, findings: [] };
    });
    const run = await execute(db, { worldOptions: { criterionList: FIVE }, model });
    expect(run.outcome.kind).toBe('succeeded');
    const rows = await judgments(run);
    expect(rows.get('official.crit_04')).toMatchObject({
      disposition: 'critic_unavailable',
      outcomeKind: 'insufficient_evidence',
      score: null,
      criticReviewed: false,
      criticAttempts: 2,
    });
  });

  /** A critic that, ONCE, reports an injection suspicion on the first cited record of `official.problem_fit`. */
  function injectionModel(rerunCitesRemoved: boolean) {
    const state: { removed: string | null } = { removed: null };
    const model = new FakeModel()
      .on('critic', (context) => {
        const { dimensionId } = unitOf(context);
        if (dimensionId === 'official.problem_fit' && state.removed === null) {
          state.removed = cited(context)[0] ?? null;
          return {
            unit: dimensionId,
            findings: [
              {
                code: 'injection_suspected',
                severity: 'minor',
                evidence: [state.removed],
                note: 'Looks like an instruction.',
              },
            ],
          };
        }
        return { unit: dimensionId, findings: [] };
      })
      .on('dimension_assessment', (context) => {
        const { dimensionId } = unitOf(context);
        const handles = candidateHandles(context, 'team_statement');
        const rerun = dimensionId === 'official.problem_fit' && state.removed !== null;
        const target = rerun && rerunCitesRemoved ? state.removed : (handles[0] ?? '');
        return {
          dimensionId,
          outcome: { kind: 'scored', score: 6 },
          citations: [{ evidence: target, directness: 'direct', specificity: 'exact', note: 'ok' }],
          rationale: 'Supported.',
          limitations: [],
        };
      });
    return { model, state };
  }

  const candidateRecords = (call: { request: Parameters<typeof parseRecords>[0] } | undefined) =>
    parseRecords(call?.request as Parameters<typeof parseRecords>[0]).filter(
      (r) => typeof r.meta['authorship'] === 'string',
    );

  it('removes injection-suspected evidence from the re-run; the remaining handles keep their numbers', async () => {
    const { model, state } = injectionModel(false);
    const run = await execute(db, { model });
    expect(run.outcome.kind).toBe('succeeded');
    const calls = run.model
      .callsOf('dimension_assessment')
      .filter((c) => c.dimensionId === 'official.problem_fit');
    expect(calls).toHaveLength(2);
    const before = candidateRecords(calls[0]).map((r) => r.handle);
    const after = candidateRecords(calls[1]).map((r) => r.handle);
    expect(state.removed).not.toBeNull();
    expect(before).toContain(state.removed);
    expect(after).not.toContain(state.removed);
    expect(after).toEqual(before.filter((h) => h !== state.removed));
    const rows = await judgments(run);
    expect(rows.get('official.problem_fit')).toMatchObject({
      disposition: 'scored',
      assessorAttempts: 2,
      criticAttempts: 2,
    });
  });

  it('a re-run that cites the removed evidence is refused (it was not shown), so the unit is technical, never scored', async () => {
    const { model } = injectionModel(true);
    const run = await execute(db, { model });
    expect(run.outcome.kind).toBe('succeeded');
    const rows = await judgments(run);
    expect(rows.get('official.problem_fit')).toMatchObject({
      disposition: 'assessor_output_invalid',
      outcomeKind: 'insufficient_evidence',
      score: null,
      assessorAttempts: 3, // the first answer, then the re-run and its single re-ask
    });
  });

  it('a refusal on the critic call makes the unit provider_refused (technical), never a score', async () => {
    const model = new FakeModel().failing('critic', (context) =>
      unitOf(context).dimensionId === 'official.crit_02'
        ? { ok: false, category: 'refused', sendState: 'sent_unknown' }
        : null,
    );
    const run = await execute(db, { worldOptions: { criterionList: FIVE }, model });
    expect(run.outcome.kind).toBe('succeeded');
    const rows = await judgments(run);
    expect(rows.get('official.crit_02')).toMatchObject({
      disposition: 'provider_refused',
      score: null,
    });
  });
});
