import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssessmentRunError, AssessmentRunStore } from './assessment-run-store.js';
import { AssessmentStore } from './assessment-store.js';
import { createDatabase, type DatabaseConnection } from './client.js';
import { analysisRuns, type JudgeDatabase } from './index.js';
import {
  CallNotReservedError,
  DatabaseRunBudget,
  reapReservedCalls,
  RunNotRunningError,
} from './run-budget-store.js';
import { requestInput } from './testing/assessment-fixtures.js';
import { extractAndBind, scoreRun, startRun } from './testing/assessment-pipeline.js';
import {
  defaultLimits,
  seedAssessmentWorld,
  type AssessmentWorld,
} from './testing/assessment-world.js';
import { openPostgres, probe, rows } from './testing/databases.js';
import { sha256 } from './testing/graph-world.js';

/*
 * R4 F3/F4: the terminal-run reservation race and the lock order, on real PostgreSQL connections (PGlite is one connection and cannot
 * interleave). Every test FORCES the interleaving it describes: a test seam holds the row lock of the real operation (finishRun,
 * recoverRun, persist) while the competing statement is started, the test waits until PostgreSQL reports that statement as blocked on a
 * lock, and only then releases the holder. Nothing is decided by sleeping.
 *
 * Lock order of every path: project -> pinned version -> RUN row -> BUDGET row -> ledger rows.
 */

const URL_ = process.env['TEST_DATABASE_URL'];

const gate = () => {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const BOUNDS = { inputTokens: 10, outputTokens: 10, costNanoUsd: 100 };
const measure = (_model: string, usage: { inputTokens: number; outputTokens: number }) => ({
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  costNanoUsd: usage.inputTokens + usage.outputTokens,
});

describe.skipIf(!URL_)('R4 F3/F4 terminal-run reservation race and lock order (PostgreSQL)', () => {
  let setup: Awaited<ReturnType<typeof openPostgres>>;
  let pool: DatabaseConnection;
  let db: JudgeDatabase;

  beforeAll(async () => {
    const url = URL_ ?? '';
    setup = await openPostgres(url);
    pool = createDatabase(url, { maxConnections: 30 });
    db = pool.db;
  });
  afterAll(async () => {
    await pool.close();
    await setup.close();
  });

  const newWorld = (): Promise<AssessmentWorld> =>
    seedAssessmentWorld(db, {
      trackKeys: ['health', 'robotics'],
      declare: ['health'],
      rules: [{ statement: 'Every project must be original work.', certainty: 'explicit' }],
    });

  /** Waits until at least `count` backends report that they are blocked on a lock. */
  async function waitUntilBlocked(count = 1): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const [row] = await rows<{ n: number }>(
        db,
        sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`,
      );
      if ((row?.n ?? 0) >= count) return;
      await sleep(15);
    }
    throw new Error('the competing statement never became blocked on a lock');
  }

  async function runningRun(
    hook?: (op: 'finish' | 'recover') => Promise<void>,
    limits = defaultLimits(),
    leaseMs = 600_000,
  ) {
    const w = await newWorld();
    const store = new AssessmentRunStore({ db, ...(hook ? { afterRunLocked: hook } : {}) });
    const requested = await store.requestAssessment(requestInput(w, { limits }));
    if (requested.kind !== 'run_created') throw new Error('not created');
    const leaseToken = await store.claimRun(requested.runId, leaseMs);
    if (!leaseToken) throw new Error('not claimed');
    return { w, store, runId: requested.runId, leaseToken };
  }
  const budgetOf = (runId: string) => new DatabaseRunBudget({ db, runId, measure });
  const reserve = (budget: DatabaseRunBudget, tag: string, bounds = BOUNDS) =>
    budget.reserve({ stage: 'critic', model: 'm', requestDigest: sha256(tag), bounds });

  /** The ledger of a finished run is complete: nothing reserved, nothing reserved after the end, totals equal the outcome. */
  async function expectConsistentEnd(runId: string, expectedState: string) {
    const [run] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, runId));
    expect(run?.state).toBe(expectedState);
    const [reserved] = await rows<{ n: number }>(
      db,
      sql`SELECT count(*)::int AS n FROM assessment_run_calls WHERE run_id = ${runId} AND state = 'reserved'`,
    );
    expect(reserved?.n).toBe(0);
    const [late] = await rows<{ n: number }>(
      db,
      sql`SELECT count(*)::int AS n FROM assessment_run_calls c JOIN analysis_runs r ON r.id = c.run_id
          WHERE c.run_id = ${runId} AND c.reserved_at > r.finished_at`,
    );
    expect(late?.n).toBe(0);
    const [totals] = await rows<Record<string, number>>(
      db,
      sql`SELECT count(*)::int AS attempts, coalesce(sum(input_tokens), 0)::bigint::float8 AS input, coalesce(sum(cost_nano_usd), 0)::bigint::float8 AS cost
          FROM assessment_run_calls WHERE run_id = ${runId}`,
    );
    const [outcome] = await rows<Record<string, number>>(
      db,
      sql`SELECT attempts_started AS attempts, input_tokens::float8 AS input, cost_nano_usd::float8 AS cost FROM assessment_run_outcomes WHERE run_id = ${runId}`,
    );
    expect(outcome).toBeDefined();
    expect({ ...totals }).toEqual({ ...outcome });
  }

  it('A: a reservation requested while finishRun holds the run lock is refused; the in-flight call is conservatively counted', async () => {
    const held = gate();
    const entered = gate();
    const { store, runId, leaseToken } = await runningRun(async () => {
      entered.open();
      await held.wait;
    });
    const budget = budgetOf(runId);
    const inflight = await reserve(budget, 'inflight');
    expect(inflight.ok).toBe(true);
    const finishing = store.finishRun({
      runId,
      leaseToken,
      state: 'failed',
      failureCode: 'test_stop',
    });
    await entered.wait; // finishRun now holds the run row FOR UPDATE and has written nothing
    const late = reserve(budget, 'late').then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await waitUntilBlocked();
    held.open();
    await finishing;
    const result = await late;
    expect('error' in result && result.error).toBeInstanceOf(RunNotRunningError);
    await expectConsistentEnd(runId, 'failed');
    const calls = await rows<{ state: string }>(
      db,
      sql`SELECT state FROM assessment_run_calls WHERE run_id = ${runId}`,
    );
    expect(calls.map((c) => c.state)).toEqual(['unknown']);
  });

  it('B: a reservation requested while a SUCCESSFUL persist holds the run lock is refused', async () => {
    const w = await newWorld();
    const run = await startRun(db, w);
    await extractAndBind(w, run);
    const scored = await scoreRun(db, w, run);
    const held = gate();
    const entered = gate();
    const store = new AssessmentStore(db, {
      afterRunLocked: async () => {
        entered.open();
        await held.wait;
      },
    });
    const persisting = store.persist(scored.persist);
    await entered.wait;
    const late = reserve(run.budget, 'late-after-persist').then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await waitUntilBlocked();
    held.open();
    expect((await persisting).kind).toBe('persisted');
    const result = await late;
    expect('error' in result && result.error).toBeInstanceOf(RunNotRunningError);
    await expectConsistentEnd(run.runId, 'succeeded');
  });

  it('C: a reservation requested while recovery ends the run is refused', async () => {
    const held = gate();
    const entered = gate();
    const { store, runId } = await runningRun(
      async () => {
        entered.open();
        await held.wait;
      },
      defaultLimits(),
      1, // the lease is 1 ms: it expires at once
    );
    await sleep(20);
    const budget = budgetOf(runId);
    const recovering = store.recoverRun(runId, new Date(Date.now() + 60_000));
    await entered.wait;
    const late = reserve(budget, 'late-in-recovery').then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await waitUntilBlocked();
    held.open();
    expect(await recovering).toBe(true);
    const result = await late;
    expect('error' in result && result.error).toBeInstanceOf(RunNotRunningError);
    await expectConsistentEnd(runId, 'failed');
  });

  it('D: a settlement racing the terminalization either lands before it or is refused after it; the totals stay complete', async () => {
    // (1) terminalization first: the late settlement finds the call already counted as unknown
    const held = gate();
    const entered = gate();
    const first = await runningRun(async () => {
      entered.open();
      await held.wait;
    });
    const budget = budgetOf(first.runId);
    const call = await reserve(budget, 'to-settle');
    if (!call.ok) throw new Error('denied');
    const finishing = first.store.finishRun({
      runId: first.runId,
      leaseToken: first.leaseToken,
      state: 'failed',
      failureCode: 'test_stop',
    });
    await entered.wait;
    const settling = budget
      .settle(call.callId, {
        kind: 'measured',
        usage: { inputTokens: 1, outputTokens: 1 },
        outcomeCode: 'ok',
        responseHash: sha256('r'),
        responseJson: { a: 1 },
      })
      .then(
        () => ({ settled: true }),
        (error: unknown) => ({ error }),
      );
    await waitUntilBlocked();
    held.open();
    await finishing;
    const outcome = await settling;
    expect('error' in outcome && outcome.error).toBeInstanceOf(CallNotReservedError);
    await expectConsistentEnd(first.runId, 'failed');
    const [row] = await rows<{ state: string; cost_nano_usd: number }>(
      db,
      sql`SELECT state, cost_nano_usd::float8 AS cost_nano_usd FROM assessment_run_calls WHERE run_id = ${first.runId}`,
    );
    expect(row).toMatchObject({ state: 'unknown', cost_nano_usd: 100 }); // the full reservation

    // (2) settlement first: finishRun then reaps nothing and the measured usage is what the outcome totals
    const second = await runningRun();
    const secondBudget = budgetOf(second.runId);
    const done = await reserve(secondBudget, 'settled-first');
    if (!done.ok) throw new Error('denied');
    await secondBudget.settle(done.callId, {
      kind: 'measured',
      usage: { inputTokens: 3, outputTokens: 4 },
      outcomeCode: 'ok',
      responseHash: sha256('r2'),
      responseJson: { b: 2 },
    });
    await second.store.finishRun({
      runId: second.runId,
      leaseToken: second.leaseToken,
      state: 'failed',
      failureCode: 'test_stop',
    });
    await expectConsistentEnd(second.runId, 'failed');
  });

  it('E: racing reservations never exceed the configured cap (calls and tokens), whatever the interleaving', async () => {
    const limits = { ...defaultLimits(), maxCalls: 5, maxInputTokens: 10_000 };
    const { runId } = await runningRun(undefined, limits);
    const budgets = Array.from(
      { length: 16 },
      () =>
        new DatabaseRunBudget({
          db,
          runId,
          measure,
          betweenCheckAndHold: () => sleep(Math.floor(Math.random() * 5)),
        }),
    );
    const results = await Promise.all(budgets.map((b, i) => reserve(b, `race-${String(i)}`)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.flatMap((r) => (r.ok ? [] : [r.denial]))).toEqual(
      Array.from({ length: 11 }, () => 'calls'),
    );
    const [count] = await rows<{ n: number }>(
      db,
      sql`SELECT count(*)::int AS n FROM assessment_run_calls WHERE run_id = ${runId}`,
    );
    expect(count?.n).toBe(5);

    // the token cap: 3 reservations of 4000 fit into 10000, a fourth does not
    const tight = await runningRun(undefined, { ...defaultLimits(), maxInputTokens: 10_000 });
    const tightResults = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        reserve(budgetOf(tight.runId), `tight-${String(i)}`, {
          inputTokens: 4_000,
          outputTokens: 10,
          costNanoUsd: 10,
        }),
      ),
    );
    expect(tightResults.filter((r) => r.ok)).toHaveLength(2);
  });

  it('F: a direct SQL ledger insert racing the terminalization is serialized by the run row, in both orders', async () => {
    const insertSql = (runId: string, digest: string) => sql`INSERT INTO assessment_run_calls
      (run_id, seq, stage, attempt, model, request_digest, reserved_input_tokens, reserved_output_tokens, reserved_cost_nano_usd, state)
      VALUES (${runId}, 0, 'critic', 1, 'm', ${digest}, 1, 1, 1, 'reserved')`;
    const endSql = (runId: string) =>
      sql`UPDATE analysis_runs SET state = 'failed', failure_category = 'internal_error', finished_at = now() WHERE id = ${runId}`;
    const outcomeSql = (runId: string, projectId: string) => sql`INSERT INTO assessment_run_outcomes
      (run_id, project_id, outcome, failure_category, failure_code, attempts_started, settled_calls, unknown_calls, released_calls, input_tokens, output_tokens, cost_nano_usd)
      VALUES (${runId}, ${projectId}, 'failed', 'internal_error', 'x', 0, 0, 0, 0, 0, 0, 0)`;

    // (1) the insert is first: it holds the run row FOR SHARE, the terminal UPDATE waits, then sees the committed reserved row and refuses
    const one = await runningRun();
    const held = gate();
    const inserted = gate();
    const inserting = db.transaction(async (tx) => {
      await tx.execute(insertSql(one.runId, sha256('direct-1')));
      inserted.open();
      await held.wait;
    });
    await inserted.wait;
    const ending = db
      .transaction((tx) => tx.execute(endSql(one.runId)))
      .then(
        () => ({ ended: true }),
        (error: unknown) => ({ error }),
      );
    await waitUntilBlocked();
    held.open();
    await inserting;
    const refused = await ending;
    expect(
      JSON.stringify((refused as { error?: { message?: string } }).error?.message ?? ''),
    ).toBeDefined();
    expect('error' in refused).toBe(true);
    const [still] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, one.runId));
    expect(still?.state).toBe('running');

    // (2) the terminalization is first: the insert waits for the run row, then sees the run ended and refuses
    const two = await runningRun();
    const held2 = gate();
    const ended = gate();
    const projectId = two.w.project.id;
    const terminating = db.transaction(async (tx) => {
      await tx.execute(endSql(two.runId));
      await tx.execute(outcomeSql(two.runId, projectId));
      ended.open();
      await held2.wait;
    });
    await ended.wait;
    const lateInsert = db
      .transaction((tx) => tx.execute(insertSql(two.runId, sha256('direct-2'))))
      .then(
        () => ({ inserted: true }),
        (error: unknown) => ({ error }),
      );
    await waitUntilBlocked();
    held2.open();
    await terminating;
    const lateResult = await lateInsert;
    expect('error' in lateResult).toBe(true);
    await expectConsistentEnd(two.runId, 'failed');
  });

  describe('F4: lease recovery is re-validated under the run lock', () => {
    it('a heartbeat that renews the lease before recovery obtains the lock prevents the recovery', async () => {
      const { runId, store } = await runningRun(undefined, defaultLimits(), 1);
      await sleep(20); // the lease (1 ms) has expired
      const before = new Date(Date.now() + 60_000);
      const held = gate();
      const locked = gate();
      const heartbeat = db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM analysis_runs WHERE id = ${runId} FOR UPDATE`);
        await tx.execute(
          sql`UPDATE analysis_runs SET lease_expires_at = now() + interval '1 hour' WHERE id = ${runId}`,
        );
        locked.open();
        await held.wait;
      });
      await locked.wait;
      // the candidate list is read from committed state (the lease still looks expired); since P6A (R5 F-1) recoverRun SKIPS the row
      // the heartbeat holds instead of waiting for it, so the pass returns at once with nothing recovered
      expect(await store.recoverExpiredRuns(before)).toEqual([]);
      held.open();
      await heartbeat;
      // after the heartbeat committed the renewed lease protects the run on the next pass as well
      expect(await store.recoverExpiredRuns(before)).toEqual([]);
      const [run] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, runId));
      expect(run?.state).toBe('running');
      expect(await store.recoverRun(runId, before)).toBe(false);
    });

    it('a real heartbeat racing recovery: exactly one of them wins and the outcome is consistent either way', async () => {
      for (let round = 0; round < 6; round += 1) {
        const { runId, store, leaseToken } = await runningRun(undefined, defaultLimits(), 1);
        await sleep(15);
        const [renewed, recovered] = await Promise.all([
          store.heartbeat(runId, leaseToken, 600_000),
          store.recoverRun(runId, new Date(Date.now() + 60_000)),
        ]);
        const [run] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, runId));
        if (recovered) {
          expect(renewed).toBe(false); // the heartbeat found the run already ended
          expect(run?.state).toBe('failed');
        } else {
          expect(renewed).toBe(true); // the heartbeat won; recovery stood down
          expect(run?.state).toBe('running');
        }
      }
    });

    it('a stale worker token cannot do anything to a recovered run', async () => {
      const { w, runId, store, leaseToken } = await runningRun(undefined, defaultLimits(), 1);
      await sleep(15);
      const budget = budgetOf(runId);
      const abandoned = await reserve(budget, 'abandoned');
      expect(abandoned.ok).toBe(true);
      expect(await store.recoverRun(runId, new Date(Date.now() + 60_000))).toBe(true);
      await expectConsistentEnd(runId, 'failed');
      // the abandoned in-flight call is counted conservatively, at its full reservation
      const [call] = await rows<{ state: string; cost: number }>(
        db,
        sql`SELECT state, cost_nano_usd::float8 AS cost FROM assessment_run_calls WHERE run_id = ${runId}`,
      );
      expect(call).toMatchObject({ state: 'unknown', cost: BOUNDS.costNanoUsd });
      // the old token: heartbeat, finish, bind, reserve and persist are all refused
      expect(await store.heartbeat(runId, leaseToken, 600_000)).toBe(false);
      await expect(
        store.finishRun({ runId, leaseToken, state: 'failed', failureCode: 'late' }),
      ).rejects.toMatchObject({ code: 'wrong_state' });
      await expect(
        store.bindExtraction(runId, leaseToken, 'source', w.project.id),
      ).rejects.toBeInstanceOf(AssessmentRunError);
      await expect(reserve(budget, 'after-recovery')).rejects.toBeInstanceOf(RunNotRunningError);
    });

    it('recovery is idempotent and safe to run from several processes at once', async () => {
      const { runId, store } = await runningRun(undefined, defaultLimits(), 1);
      await sleep(15);
      const before = new Date(Date.now() + 60_000);
      const results = await Promise.all(
        Array.from({ length: 6 }, () => store.recoverRun(runId, before)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await store.recoverExpiredRuns(before)).not.toContain(runId);
      await expectConsistentEnd(runId, 'failed');
    });
  });

  it('the documented order holds for direct SQL as well: a terminal UPDATE and the reaper both take the budget row after the run row', async () => {
    const { runId } = await runningRun();
    const hold = async (action: () => Promise<unknown>) => {
      const held = gate();
      const locked = gate();
      const holder = db.transaction(async (tx) => {
        // outside the protocol: nothing but the budget row is held
        await tx.execute(
          sql`SELECT run_id FROM assessment_run_budget WHERE run_id = ${runId} FOR UPDATE`,
        );
        locked.open();
        await held.wait;
      });
      await locked.wait;
      const acting = action().then(
        () => 'done',
        (error: unknown) => error,
      );
      await waitUntilBlocked(); // it cannot finish while the budget row is held
      held.open();
      await holder;
      return acting;
    };
    // a direct terminal UPDATE (rolled back afterwards): the transition trigger waits for the budget row
    expect(
      await hold(() =>
        probe(db, async (tx) => {
          await tx.execute(
            sql`UPDATE analysis_runs SET state = 'failed', failure_category = 'internal_error', finished_at = now() WHERE id = ${runId}`,
          );
        }),
      ),
    ).toBe('done');
    // the reaper of the store: it waits for the budget row too
    expect(
      await hold(() => db.transaction((tx) => reapReservedCalls(tx, runId, 'test_reap'))),
    ).toBe('done');
  });

  it('G: randomized concurrent interleavings never deadlock and always leave a complete ledger', async () => {
    const seeds = Array.from({ length: 14 }, (_, i) => 1_000 + i * 7919);
    const rng = (seed: number) => {
      let a = seed;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    const tolerated = (error: unknown): boolean =>
      error instanceof RunNotRunningError ||
      error instanceof CallNotReservedError ||
      (error instanceof AssessmentRunError && error.code === 'wrong_state');
    for (const seed of seeds) {
      const next = rng(seed);
      const limits = { ...defaultLimits(), maxCalls: 6 };
      const { store, runId, leaseToken } = await runningRun(undefined, limits, 1);
      const budget = budgetOf(runId);
      const reserved: number[] = [];
      const tasks: Promise<void>[] = [];
      const run = (work: () => Promise<unknown>) =>
        tasks.push(
          (async () => {
            await sleep(Math.floor(next() * 12));
            try {
              await work();
            } catch (error) {
              if (!tolerated(error)) throw error;
            }
          })(),
        );
      const count = 3 + Math.floor(next() * 5);
      for (let i = 0; i < count; i += 1) {
        run(async () => {
          const r = await reserve(budgetOf(runId), `r-${String(seed)}-${String(i)}`);
          if (r.ok) reserved.push(r.callId);
        });
        run(async () => {
          await sleep(5);
          const target = reserved[Math.floor(next() * reserved.length)];
          if (target === undefined) return;
          const roll = next();
          await budget.settle(
            target,
            roll < 0.5
              ? {
                  kind: 'measured',
                  usage: { inputTokens: 2, outputTokens: 2 },
                  outcomeCode: 'ok',
                  responseHash: sha256('r'),
                  responseJson: { ok: true },
                }
              : roll < 0.75
                ? { kind: 'released', outcomeCode: 'not_sent' }
                : { kind: 'unknown', outcomeCode: 'timeout' },
          );
        });
      }
      run(() => budget.reapInFlight());
      run(() => store.heartbeat(runId, leaseToken, 1));
      // the run ends by one of two paths, racing everything above
      run(() =>
        next() < 0.5
          ? store.finishRun({ runId, leaseToken, state: 'cancelled', failureCode: 'random_stop' })
          : store.recoverRun(runId, new Date(Date.now() + 60_000)),
      );
      await Promise.all(tasks); // a deadlock or an unexpected error rejects here
      // make sure the run is over, whatever the random order did
      await store.recoverRun(runId, new Date(Date.now() + 60_000));
      const [row] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, runId));
      if (row?.state === 'running') {
        await store.finishRun({
          runId,
          leaseToken,
          state: 'cancelled',
          failureCode: 'random_stop',
        });
      }
      const [final] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, runId));
      await expectConsistentEnd(runId, final?.state ?? 'missing');
      const [attempts] = await rows<{ n: number }>(
        db,
        sql`SELECT count(*)::int AS n FROM assessment_run_calls WHERE run_id = ${runId}`,
      );
      expect(attempts?.n ?? 0).toBeLessThanOrEqual(6);
    }
  }, 120_000);
});
