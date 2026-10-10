import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { microToNanoUsd, nanoToMicroUsdCeil } from './assessment-hashes.js';
import { assessmentRunCalls, assessmentRunOutcomes, type JudgeDatabase } from './index.js';
import { backstopReason, closedSetHash, DatabaseRunBudget } from './run-budget-store.js';
import { createdRunId, newRunStore, requestInput } from './testing/assessment-fixtures.js';
import { seedAssessmentWorld, type AssessmentWorld } from './testing/assessment-world.js';
import {
  expectPgError,
  rows,
  SQLSTATE,
  testDatabaseTargets,
  type TestDatabase,
} from './testing/databases.js';
import { sha256 } from './testing/graph-world.js';
import { AssessmentRunLimits } from '@judge-copilot/schemas';

const { CHECK_VIOLATION, RESTRICT_VIOLATION } = SQLSTATE;

describe.each(testDatabaseTargets())('M5 P4 call ledger: database guards on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;
  let w: AssessmentWorld;
  let runId: string;
  let budget: DatabaseRunBudget;

  beforeAll(async () => {
    testDb = await open();
    db = testDb.db;
  });
  afterAll(async () => {
    await testDb.close();
  });
  beforeEach(async () => {
    await startRun({});
  });

  async function startRun(limits: Record<string, number>) {
    w = await seedAssessmentWorld(db);
    const store = newRunStore(db);
    runId = createdRunId(
      await store.requestAssessment(requestInput(w, { limits: AssessmentRunLimits.parse(limits) })),
    );
    await store.claimRun(runId, 600_000);
    budget = new DatabaseRunBudget({
      db,
      runId,
      measure: (_model, usage) => ({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costNanoUsd: usage.inputTokens + usage.outputTokens,
      }),
    });
  }
  const bounds = { inputTokens: 100, outputTokens: 50, costNanoUsd: 1_000 };
  const reserve = (digest = sha256('d'), stage = 'claim_extraction') =>
    budget.reserve({ stage, model: 'm', requestDigest: digest, bounds });

  it('stores money as exact nano-USD and converts to micro-USD only upwards (usage is never rounded away)', async () => {
    const r = await budget.reserve({
      stage: 'critic',
      model: 'm',
      requestDigest: sha256('n'),
      bounds: { inputTokens: 1, outputTokens: 1, costNanoUsd: 1 },
    });
    expect(r.ok).toBe(true);
    const [entry] = await budget.entries();
    expect(entry?.reservation.costNanoUsd).toBe(1);
    expect(nanoToMicroUsdCeil(1)).toBe(1);
    expect(nanoToMicroUsdCeil(1_000)).toBe(1);
    expect(nanoToMicroUsdCeil(1_001)).toBe(2);
    expect(nanoToMicroUsdCeil(0)).toBe(0);
    expect(microToNanoUsd(3)).toBe(3_000);
    expect(() => nanoToMicroUsdCeil(-1)).toThrow(RangeError);
    expect(() => nanoToMicroUsdCeil(1.5)).toThrow(RangeError);
    expect(() => microToNanoUsd(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
    // the largest exact integer a JavaScript number holds survives the round trip; one more is rejected by the column CHECK
    const max = Number.MAX_SAFE_INTEGER;
    await expectPgError(
      db.execute(
        sql`UPDATE assessment_run_calls SET cost_nano_usd = ${max + 1} WHERE run_id = ${runId}`,
      ),
      CHECK_VIOLATION,
      RESTRICT_VIOLATION,
    );
  });

  it('the wall clock runs from the moment the run was CLAIMED (the queue wait is not charged), in the application and in the trigger', async () => {
    w = await seedAssessmentWorld(db);
    // a run claimed ten minutes ago, with a one-minute wall-clock limit
    const store = newRunStore(db, () => new Date(Date.now() - 10 * 60_000));
    const id = createdRunId(
      await store.requestAssessment(
        requestInput(w, { limits: AssessmentRunLimits.parse({ runWallClockMs: 60_000 }) }),
      ),
    );
    await store.claimRun(id, 3_600_000);
    const expired = new DatabaseRunBudget({ db, runId: id, measure: () => null });
    expect(
      await expired.reserve({ stage: 'critic', model: 'm', requestDigest: sha256('w'), bounds }),
    ).toEqual({ ok: false, denial: 'wall_clock' });
    // and the database refuses the same attempt even when written around the application
    await expectPgError(
      db.execute(sql`INSERT INTO assessment_run_calls
        (run_id, seq, stage, attempt, model, request_digest, reserved_input_tokens, reserved_output_tokens, reserved_cost_nano_usd, state)
        VALUES (${id}, 0, 'critic', 1, 'm', ${sha256('w2')}, 1, 1, 1, 'reserved')`),
      CHECK_VIOLATION,
    );
    // a freshly claimed run is not penalized for how long it waited
    const fresh = createdRunId(
      await newRunStore(db).requestAssessment(
        requestInput(await seedAssessmentWorld(db), {
          limits: AssessmentRunLimits.parse({ runWallClockMs: 60_000 }),
        }),
      ),
    );
    await newRunStore(db).claimRun(fresh, 3_600_000);
    const ok = new DatabaseRunBudget({ db, runId: fresh, measure: () => null });
    expect(
      (await ok.reserve({ stage: 'critic', model: 'm', requestDigest: sha256('w3'), bounds })).ok,
    ).toBe(true);
  });

  describe('the insert trigger is a backstop even for direct SQL', () => {
    const insertDirect = (overrides: Record<string, unknown> = {}) =>
      db.execute(sql`INSERT INTO assessment_run_calls
        (run_id, seq, stage, attempt, model, request_digest, reserved_input_tokens, reserved_output_tokens, reserved_cost_nano_usd, state)
        VALUES (${runId}, 0, 'critic', 1, 'm', ${(overrides['digest'] as string | undefined) ?? sha256('direct')},
                ${Number(overrides['input'] ?? 10)}, ${Number(overrides['output'] ?? 10)}, ${Number(overrides['cost'] ?? 10)}, 'reserved')`);

    it('rejects an attempt beyond the call limit with the denial reason', async () => {
      await startRun({ maxCalls: 1 });
      await insertDirect({ digest: sha256('one') });
      await expectPgError(insertDirect({ digest: sha256('two') }), CHECK_VIOLATION);
    });

    it('rejects an attempt beyond the input, output or cost limit, and one beyond the per-call bound', async () => {
      await startRun({
        maxInputTokens: 100,
        maxOutputTokens: 100,
        maxCostNanoUsd: 100,
        maxReservedInputTokensPerCall: 60,
      });
      await expectPgError(insertDirect({ input: 61 }), CHECK_VIOLATION);
      await insertDirect({ digest: sha256('a'), input: 60 });
      await expectPgError(insertDirect({ digest: sha256('b'), input: 60 }), CHECK_VIOLATION);
      await expectPgError(
        insertDirect({ digest: sha256('c'), output: 200, input: 1 }),
        CHECK_VIOLATION,
      );
      await expectPgError(
        insertDirect({ digest: sha256('d'), cost: 101, input: 1 }),
        CHECK_VIOLATION,
      );
    });

    it('the application maps the trigger denial to a typed error', async () => {
      const denial = Object.assign(new Error('assessment budget denied: calls'), { hint: 'calls' });
      expect(backstopReason(new Error('failed query', { cause: denial }))).toBe('calls');
      expect(backstopReason(new Error('something else'))).toBeNull();
      // and a denial raised by the real trigger carries the reason in its message on this driver
      await startRun({ maxCalls: 1 });
      await insertDirect({ digest: sha256('first') });
      let caught: unknown;
      try {
        await insertDirect({ digest: sha256('second') });
      } catch (error) {
        caught = error;
      }
      expect(backstopReason(caught)).toBe('calls');
    });

    it('records calls only for a RUNNING assessment run', async () => {
      const store = newRunStore(db);
      await store.finishRun({ runId, state: 'failed', failureCode: 'x' });
      await expectPgError(insertDirect(), CHECK_VIOLATION);
    });

    it('assigns seq and attempt itself (a caller cannot choose them)', async () => {
      await insertDirect({ digest: sha256('same') });
      await insertDirect({ digest: sha256('same') });
      const stored = await db
        .select()
        .from(assessmentRunCalls)
        .where(eq(assessmentRunCalls.runId, runId));
      expect(stored.map((row) => [row.seq, row.attempt])).toEqual([
        [1, 1],
        [2, 2],
      ]);
    });
  });

  describe('only reserved -> settled | released | unknown, once', () => {
    it('refuses UPDATE of a terminal row, DELETE, TRUNCATE and CASCADE', async () => {
      const r = await reserve();
      if (!r.ok) throw new Error('denied');
      await budget.settle(r.callId, { kind: 'released', outcomeCode: 'rate_limited' });
      await expectPgError(
        db.execute(
          sql`UPDATE assessment_run_calls SET outcome_code = 'changed' WHERE run_id = ${runId}`,
        ),
        RESTRICT_VIOLATION,
      );
      await expectPgError(
        db.delete(assessmentRunCalls).where(eq(assessmentRunCalls.runId, runId)),
        RESTRICT_VIOLATION,
      );
      await expectPgError(db.execute(sql`TRUNCATE assessment_run_calls`), RESTRICT_VIOLATION);
      await expectPgError(
        db.execute(sql`TRUNCATE assessment_run_budget CASCADE`),
        RESTRICT_VIOLATION,
      );
      await expectPgError(db.execute(sql`TRUNCATE analysis_runs CASCADE`), RESTRICT_VIOLATION);
    });

    it('refuses to change a reservation or an identity column while settling', async () => {
      const r = await reserve();
      if (!r.ok) throw new Error('denied');
      await expectPgError(
        db.execute(
          sql`UPDATE assessment_run_calls SET state = 'released', outcome_code = 'x', model = 'other' WHERE run_id = ${runId}`,
        ),
        RESTRICT_VIOLATION,
      );
      await expectPgError(
        db.execute(
          sql`UPDATE assessment_run_calls SET state = 'released', outcome_code = 'x', reserved_cost_nano_usd = 1 WHERE run_id = ${runId}`,
        ),
        RESTRICT_VIOLATION,
      );
      await expectPgError(
        db.execute(sql`UPDATE assessment_run_calls SET state = 'reserved' WHERE run_id = ${runId}`),
        RESTRICT_VIOLATION,
      );
    });

    it('refuses inconsistent ledger states (the row shape is checked)', async () => {
      await reserve();
      // settled without measured usage
      await expectPgError(
        db.execute(
          sql`UPDATE assessment_run_calls SET state = 'settled', outcome_code = 'ok' WHERE run_id = ${runId}`,
        ),
        CHECK_VIOLATION,
      );
      // unknown that does not carry the full reservation
      await expectPgError(
        db.execute(
          sql`UPDATE assessment_run_calls SET state = 'unknown', usage_basis = 'unknown_reserved', input_tokens = 1, output_tokens = 1, cost_nano_usd = 1, outcome_code = 'x' WHERE run_id = ${runId}`,
        ),
        CHECK_VIOLATION,
      );
      // released with usage
      await expectPgError(
        db.execute(
          sql`UPDATE assessment_run_calls SET state = 'released', input_tokens = 5, outcome_code = 'x' WHERE run_id = ${runId}`,
        ),
        CHECK_VIOLATION,
      );
      // an oversized or malformed response record
      await expectPgError(
        db.execute(
          sql`UPDATE assessment_run_calls SET state = 'settled', usage_basis = 'measured', input_tokens = 1, output_tokens = 1, cost_nano_usd = 1, outcome_code = 'ok', response_record = 'stored' WHERE run_id = ${runId}`,
        ),
        CHECK_VIOLATION,
      );
      await expectPgError(
        db.execute(
          sql`UPDATE assessment_run_calls SET state = 'settled', usage_basis = 'measured', input_tokens = 1, output_tokens = 1, cost_nano_usd = 1, outcome_code = 'ok', response_record = 'stored', response_canonical = repeat('x', 262145), response_bytes = 262145 WHERE run_id = ${runId}`,
        ),
        CHECK_VIOLATION,
      );
      const [entry] = await budget.entries();
      expect(entry?.state).toBe('reserved');
    });

    it('the settle trigger records the settle time and recomputes the bound violation itself', async () => {
      const r = await reserve();
      if (!r.ok) throw new Error('denied');
      await budget.settle(r.callId, {
        kind: 'measured',
        usage: { inputTokens: 500, outputTokens: 1 },
        outcomeCode: 'ok',
        responseHash: null,
      });
      const [stored] = await db
        .select()
        .from(assessmentRunCalls)
        .where(eq(assessmentRunCalls.runId, runId));
      expect(stored?.boundViolation).toBe(true);
      expect(stored?.settledAt).toBeInstanceOf(Date);
    });
  });

  describe('outcome totals are the ledger totals', () => {
    it('refuses an outcome whose totals disagree with the ledger, or while a call is reserved', async () => {
      const r = await reserve();
      if (!r.ok) throw new Error('denied');
      await expectPgError(
        db.transaction(async (tx) => {
          await tx.execute(
            sql`UPDATE analysis_runs SET state = 'failed', failure_category = 'internal_error', finished_at = now() WHERE id = ${runId}`,
          );
        }),
        CHECK_VIOLATION,
      );
      await budget.settle(r.callId, { kind: 'unknown', outcomeCode: 'timeout' });
      await expectPgError(
        db.transaction(async (tx) => {
          await tx.execute(
            sql`UPDATE analysis_runs SET state = 'failed', failure_category = 'internal_error', finished_at = now() WHERE id = ${runId}`,
          );
          await tx.insert(assessmentRunOutcomes).values({
            runId,
            projectId: w.project.id,
            outcome: 'failed',
            failureCategory: 'internal_error',
            failureCode: 'x',
            attemptsStarted: 1,
            settledCalls: 0,
            unknownCalls: 1,
            releasedCalls: 0,
            inputTokens: 100,
            outputTokens: 50,
            costNanoUsd: 999, // the ledger says 1000
          });
        }),
        CHECK_VIOLATION,
      );
      // the honest write succeeds and is exact
      await newRunStore(db).finishRun({
        runId,
        state: 'failed',
        failureCategory: 'budget_exceeded',
        failureCode: 'cost',
      });
      const [outcome] = await db
        .select()
        .from(assessmentRunOutcomes)
        .where(eq(assessmentRunOutcomes.runId, runId));
      expect(outcome).toMatchObject({
        unknownCalls: 1,
        costNanoUsd: 1_000,
        outcome: 'failed',
        failureCategory: 'budget_exceeded',
      });
    });
  });

  describe('closed-set binding (R3 A5.3)', () => {
    it('a call stores the closed set of ITS request, bound to the stage and the digest', async () => {
      const setA = { passages: ['P-0001', 'P-0002'] };
      const setB = { passages: ['P-0003'] };
      budget.register(sha256('A'), {
        closedSet: setA,
        promptId: 'claim-extraction',
        promptVersion: 'v2',
        provider: 'scripted',
        providerMode: 'scripted',
        schemaId: 's',
        schemaVersion: 'v1',
        promptTemplateHash: sha256('tpl'),
        generationSettings: { effort: 'low', maxOutputTokens: 1000 },
      });
      budget.register(sha256('B'), { closedSet: setB });
      const a = await reserve(sha256('A'), 'claim_extraction');
      const b = await reserve(sha256('B'), 'claim_extraction');
      if (!a.ok || !b.ok) throw new Error('denied');
      const bindingA = await budget.bindingOf(a.callId);
      const bindingB = await budget.bindingOf(b.callId);
      expect(bindingA).toMatchObject({
        stage: 'claim_extraction',
        requestDigest: sha256('A'),
        closedSet: setA,
      });
      expect(bindingB?.closedSet).toEqual(setB);
      expect(bindingA?.closedSetHash).toBe(closedSetHash('claim_extraction', sha256('A'), setA));
      // the same handles under another stage or digest hash differently: they cannot be moved to another call
      expect(closedSetHash('critic', sha256('A'), setA)).not.toBe(bindingA?.closedSetHash);
      expect(closedSetHash('claim_extraction', sha256('B'), setA)).not.toBe(
        bindingA?.closedSetHash,
      );
      // and the stored row is immutable
      await expectPgError(
        db.execute(
          sql`UPDATE assessment_run_calls SET closed_set = ${JSON.stringify(setB)}::jsonb, state = 'released', outcome_code = 'x' WHERE run_id = ${runId} AND seq = ${a.callId}`,
        ),
        RESTRICT_VIOLATION,
      );
      const [row] = await rows<{
        prompt_id: string;
        provider_mode: string;
        schema_version: string;
      }>(
        db,
        sql`SELECT prompt_id, provider_mode, schema_version FROM assessment_run_calls WHERE run_id = ${runId} AND seq = ${a.callId}`,
      );
      expect(row).toMatchObject({
        prompt_id: 'claim-extraction',
        provider_mode: 'scripted',
        schema_version: 'v1',
      });
    });

    it('a call without a registered set has no binding; nothing secret-shaped is a column', async () => {
      const r = await reserve(sha256('plain'));
      if (!r.ok) throw new Error('denied');
      expect(await budget.bindingOf(r.callId)).toBeNull();
      const columns = await rows<{ column_name: string }>(
        db,
        sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'assessment_run_calls'`,
      );
      expect(
        columns
          .map((c) => c.column_name)
          .filter((c) => /prompt_text|system|api_key|secret|credential|header|token_value/.test(c)),
      ).toEqual([]);
    });
  });
});
