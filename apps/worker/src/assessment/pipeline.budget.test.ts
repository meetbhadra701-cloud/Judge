import {
  assessmentRunCalls,
  assessmentRunOutcomes,
  type JudgeDatabase,
} from '@judge-copilot/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS, FakeModel, ok, type Context } from '../testing/fake-model.js';
import { testDatabaseTargets, type TestDatabase } from '../testing/harness.js';
import { execute, expectNoAssessment, type Executed } from '../testing/run.js';

const EXTRACTION_STAGES = [
  'claim_extraction',
  'evidence_interpretation',
  'fidelity_review',
  'relation_matching',
  'relation_verification',
  'contradiction_detection',
  'unknown_identification',
] as const;

/** A model whose FIRST answer to every extraction stage is unusable (a shape failure), so each stage needs its single re-ask. */
function flakyExtraction(): FakeModel {
  const model = new FakeModel();
  const seen = new Map<string, number>();
  for (const stage of EXTRACTION_STAGES) {
    model.failing(stage, (context: Context) => {
      const count = (seen.get(stage) ?? 0) + 1;
      seen.set(stage, count);
      return count === 1 ? ok('unusable') : ok(DEFAULTS[stage](context));
    });
  }
  return model;
}

describe.each(testDatabaseTargets())(
  'the local spending guard in the pipeline on %s',
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

    async function ledger(run: Executed) {
      const rows = await db
        .select()
        .from(assessmentRunCalls)
        .where(eq(assessmentRunCalls.runId, run.runId));
      return rows.sort((a, b) => a.seq - b.seq);
    }

    it('fails the preflight BEFORE any spend when the projected run cannot fit the call limit', async () => {
      const run = await execute(db, { limits: { maxCalls: 5 } });
      expect(run.outcome).toMatchObject({
        kind: 'failed',
        category: 'budget_exceeded',
        code: 'preflight_plan_exceeds_limits',
      });
      expect(run.model.calls).toHaveLength(0);
      expect(await ledger(run)).toHaveLength(0);
      await expectNoAssessment(run, db);
      expect(await run.outcomeRow()).toMatchObject({
        outcome: 'failed',
        attemptsStarted: 0,
        costNanoUsd: 0,
      });
    });

    it('stops spending the moment a reservation would cross the cost limit, and produces no score', async () => {
      // The projected run fits (the preflight estimates EXPECTED usage), but the assessor may emit up to 30,000 tokens, and the guard
      // reserves that worst case before the call: the first assessor reservation cannot fit, so nothing is sent.
      const run = await execute(db, {
        limits: { maxCostNanoUsd: 120_000_000 },
        models: { maxOutputTokens: { assessment: 30_000 } },
      });
      expect(run.outcome).toMatchObject({
        kind: 'failed',
        category: 'budget_exceeded',
        stage: 'dimension_assessment',
      });
      expect(run.model.callsOf('dimension_assessment')).toHaveLength(0);
      expect(run.model.calls).toHaveLength(7); // S2-S6 including S3b and S4b, nothing after
      const rows = await ledger(run);
      expect(rows.every((row) => row.state === 'settled')).toBe(true);
      await expectNoAssessment(run, db);
    });

    it('refuses a single attempt whose worst-case input exceeds the per-call bound', async () => {
      const run = await execute(db, { limits: { maxReservedInputTokensPerCall: 1_000 } });
      expect(run.outcome).toMatchObject({ kind: 'failed', category: 'budget_exceeded' });
      expect(run.model.calls).toHaveLength(0);
      await expectNoAssessment(run, db);
    });

    it('counts every repair re-ask as an attempt, and the guard stops EXACTLY at the call limit', async () => {
      // the preflight plans 17 calls for this world; every extraction stage needs a re-ask, so reality needs more
      const model = flakyExtraction().failing('dimension_assessment', (context, call) =>
        context.request.stage === 'dimension_assessment' && call === 2
          ? { ok: false, category: 'rate_limited', sendState: 'not_sent' }
          : null,
      );
      const run = await execute(db, { limits: { maxCalls: 17 }, model });
      expect(run.outcome).toMatchObject({ kind: 'failed', category: 'budget_exceeded' });
      // the retry storm on the last permitted attempts never reached the provider beyond the limit
      expect(run.model.calls).toHaveLength(17);
      const rows = await ledger(run);
      expect(rows).toHaveLength(17);
      const states = rows.map((row) => row.state);
      expect(states.filter((state) => state === 'released')).toHaveLength(1); // the provably-unsent transient failure keeps its slot
      expect(await run.outcomeRow()).toMatchObject({
        outcome: 'failed',
        failureCategory: 'budget_exceeded',
        attemptsStarted: 17,
      });
      await expectNoAssessment(run, db);
    });

    it('retry exhaustion: three attempts, each its own ledger row, then the run fails provider_error with no assessment', async () => {
      const model = new FakeModel().failing('claim_extraction', () => ({
        ok: false,
        category: 'provider_unavailable',
        sendState: 'not_sent',
      }));
      const run = await execute(db, { model });
      expect(run.outcome).toMatchObject({
        kind: 'failed',
        category: 'provider_error',
        code: 'provider_unavailable',
      });
      expect(run.model.callsOf('claim_extraction')).toHaveLength(3);
      const rows = await ledger(run);
      expect(rows.map((row) => row.state)).toEqual(['released', 'released', 'released']);
      expect(await run.outcomeRow()).toMatchObject({
        attemptsStarted: 3,
        releasedCalls: 3,
        costNanoUsd: 0,
      });
      await expectNoAssessment(run, db);
    });

    it('an ambiguous failure (timeout after the request was sent) stays counted at its full reservation', async () => {
      const model = new FakeModel().failing('claim_extraction', () => ({
        ok: false,
        category: 'timeout',
        sendState: 'sent_unknown',
      }));
      const run = await execute(db, { model });
      expect(run.outcome).toMatchObject({ kind: 'failed', category: 'timeout' });
      const rows = await ledger(run);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.every((row) => row.state === 'unknown')).toBe(true);
      const outcome = (
        await db
          .select()
          .from(assessmentRunOutcomes)
          .where(eq(assessmentRunOutcomes.runId, run.runId))
      )[0];
      expect(outcome?.unknownCalls).toBe(rows.length);
      expect(outcome?.costNanoUsd).toBeGreaterThan(0); // the worst case is counted, not assumed free
      await expectNoAssessment(run, db);
    });

    it('a transient failure followed by success is absorbed: one released attempt, the run completes', async () => {
      const model = new FakeModel().failing('relation_matching', (_context, call) =>
        call === 1 ? { ok: false, category: 'rate_limited', sendState: 'not_sent' } : null,
      );
      const run = await execute(db, { model });
      expect(run.outcome.kind).toBe('succeeded');
      const rows = await ledger(run);
      expect(rows.filter((row) => row.state === 'released')).toHaveLength(1);
      expect(rows.filter((row) => row.stage === 'relation_matching')).toHaveLength(2);
    });

    it('a provider refusal on an extraction call fails the run provider_error; truncation is a schema failure', async () => {
      const refused = await execute(db, {
        model: new FakeModel().failing('claim_extraction', () => ({
          ok: false,
          category: 'refused',
          sendState: 'sent_unknown',
        })),
      });
      expect(refused.outcome).toMatchObject({
        kind: 'failed',
        category: 'provider_error',
        code: 'provider_refused_claim_extraction',
      });
      const truncated = await execute(db, {
        model: new FakeModel().failing('claim_extraction', () => ({
          ok: false,
          category: 'truncated',
          sendState: 'sent_unknown',
          usage: { inputTokens: 100, outputTokens: 8000 },
        })),
      });
      expect(truncated.outcome).toMatchObject({
        kind: 'failed',
        category: 'schema_validation_failed',
      });
    });

    it('ends a run whose wall-clock limit has passed with category timeout', async () => {
      const run = await execute(db, { limits: { runWallClockMs: 1 } });
      expect(run.outcome).toMatchObject({ kind: 'failed', category: 'timeout' });
      await expectNoAssessment(run, db);
    });
  },
);
