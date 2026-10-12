import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssessmentRunStore } from './assessment-run-store.js';
import { createDatabase, type DatabaseConnection } from './client.js';
import { analysisRuns, assessmentRunOutcomes, type JudgeDatabase } from './index.js';
import { createdRunId, requestInput } from './testing/assessment-fixtures.js';
import { seedAssessmentWorld } from './testing/assessment-world.js';
import { openPostgres, testDatabaseTargets, type TestDatabase } from './testing/databases.js';

/*
 * P6A (R5 F-1): `claimNextRun`, the SKIP LOCKED claim, and the nonblocking maintenance operations. Semantics on PGlite and
 * PostgreSQL; concurrency against a held row lock on real PostgreSQL with independent pools.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const gate = () => {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
};

async function newPending(db: JudgeDatabase): Promise<string> {
  const world = await seedAssessmentWorld(db, {
    trackKeys: ['health'],
    declare: ['health'],
    rules: [{ statement: 'Every project must be original work.', certainty: 'explicit' }],
  });
  const id = createdRunId(
    await new AssessmentRunStore({ db }).requestAssessment(requestInput(world)),
  );
  await sleep(5);
  return id;
}

describe.each(testDatabaseTargets())('claimNextRun semantics on %s', (_name, open) => {
  let database: TestDatabase;
  let db: JudgeDatabase;
  beforeAll(async () => {
    database = await open();
    db = database.db;
  });
  afterAll(async () => {
    await database.close();
  });

  const stateOf = async (id: string) =>
    (await db.select().from(analysisRuns).where(eq(analysisRuns.id, id)))[0];

  it('claims the OLDEST pending run with its lease in one step, once; nothing is left to claim afterwards', async () => {
    const a = await newPending(db);
    const b = await newPending(db);
    const store = new AssessmentRunStore({ db });
    const first = await store.claimNextRun(60_000);
    expect(first?.runId).toBe(a);
    const second = await store.claimNextRun(60_000);
    expect(second?.runId).toBe(b);
    expect(await store.claimNextRun(60_000)).toBeNull();
    for (const [id, claim] of [
      [a, first],
      [b, second],
    ] as const) {
      const run = await stateOf(id);
      expect(run).toMatchObject({
        state: 'running',
        attemptCount: 1,
        leaseToken: claim?.leaseToken,
      });
      expect(run?.leaseExpiresAt).not.toBeNull();
      expect(run?.startedAt).not.toBeNull();
    }
    // the returned lease is the run's real lease: it heartbeats and finishes with it
    expect(await store.heartbeat(a, first?.leaseToken ?? '', 60_000)).toBe(true);
    await store.finishRun({
      runId: a,
      leaseToken: first?.leaseToken ?? '',
      state: 'cancelled',
      failureCode: 'done',
    });
    await store.finishRun({
      runId: b,
      leaseToken: second?.leaseToken ?? '',
      state: 'cancelled',
      failureCode: 'done',
    });
  });

  it('never returns a running or terminal run, and a claimed run cannot be claimed again by id', async () => {
    const a = await newPending(db);
    const store = new AssessmentRunStore({ db });
    const claim = await store.claimNextRun(60_000);
    expect(claim?.runId).toBe(a);
    expect(await store.claimRun(a, 60_000)).toBeNull(); // the pipeline cannot claim it a second time
    expect(await store.claimNextRun(60_000)).toBeNull();
    await store.finishRun({
      runId: a,
      leaseToken: claim?.leaseToken ?? '',
      state: 'failed',
      failureCode: 'x',
    });
    expect(await store.claimNextRun(60_000)).toBeNull();
  });

  it('createdAfter keeps a run that the pending-expiry policy is about to cancel from being started; that run is then expired, not claimed', async () => {
    const a = await newPending(db);
    const store = new AssessmentRunStore({ db });
    const future = new Date(Date.now() + 3_600_000);
    expect(await store.claimNextRun(60_000, { createdAfter: future })).toBeNull();
    expect((await stateOf(a))?.state).toBe('pending');
    expect(await store.expirePendingRun(a, future)).toBe(true);
    expect(await store.claimNextRun(60_000)).toBeNull();
    const [outcome] = await db
      .select()
      .from(assessmentRunOutcomes)
      .where(eq(assessmentRunOutcomes.runId, a));
    expect(outcome?.failureCode).toBe('pending_expired');
  });
});

const URL_ = process.env['TEST_DATABASE_URL'];

describe.skipIf(!URL_)('claimNextRun and maintenance under competing sessions (PostgreSQL)', () => {
  let setup: TestDatabase;
  const pools: DatabaseConnection[] = [];
  const dbOf = (i: number): JudgeDatabase => pools[i]?.db as JudgeDatabase;

  beforeAll(async () => {
    setup = await openPostgres(URL_ ?? '');
    for (let i = 0; i < 5; i += 1) pools.push(createDatabase(URL_ ?? '', { maxConnections: 6 }));
  });
  afterAll(async () => {
    for (const pool of pools) await pool.close();
    await setup.close();
  });

  async function holdLock(index: number, runId: string) {
    const entered = gate();
    const release = gate();
    const done = dbOf(index).transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM analysis_runs WHERE id = ${runId} FOR UPDATE`);
      entered.open();
      await release.wait;
    });
    await entered.wait;
    return { release: release.open, done };
  }

  it('a locked oldest run is SKIPPED at once: the next run is returned without waiting', async () => {
    const [a, b] = [await newPending(dbOf(0)), await newPending(dbOf(0))];
    const lock = await holdLock(1, a);
    const started = Date.now();
    const claim = await new AssessmentRunStore({ db: dbOf(2) }).claimNextRun(60_000);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(claim?.runId).toBe(b);
    expect(await new AssessmentRunStore({ db: dbOf(2) }).claimNextRun(60_000)).toBeNull(); // only the locked one is left
    lock.release();
    await lock.done;
    const late = await new AssessmentRunStore({ db: dbOf(2) }).claimNextRun(60_000);
    expect(late?.runId).toBe(a);
    for (const c of [claim, late]) {
      await new AssessmentRunStore({ db: dbOf(0) }).finishRun({
        runId: c?.runId ?? '',
        leaseToken: c?.leaseToken ?? '',
        state: 'cancelled',
        failureCode: 'done',
      });
    }
  });

  it('four workers claiming concurrently receive every run exactly once (no duplicate, no loss), attemptCount 1', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) ids.push(await newPending(dbOf(0)));
    const got: { worker: number; runId: string; leaseToken: string }[] = [];
    await Promise.all(
      [1, 2, 3, 4].map(async (worker) => {
        const store = new AssessmentRunStore({ db: dbOf(worker) });
        for (;;) {
          const claim = await store.claimNextRun(300_000);
          if (claim === null) return;
          got.push({ worker, ...claim });
        }
      }),
    );
    expect(got.map((g) => g.runId).sort()).toEqual([...ids].sort());
    const rows = await dbOf(0).select().from(analysisRuns).where(inArray(analysisRuns.id, ids));
    expect(rows.every((r) => r.state === 'running' && r.attemptCount === 1)).toBe(true);
    for (const g of got) {
      expect(rows.find((r) => r.id === g.runId)?.leaseToken).toBe(g.leaseToken);
      await new AssessmentRunStore({ db: dbOf(0) }).finishRun({
        runId: g.runId,
        leaseToken: g.leaseToken,
        state: 'cancelled',
        failureCode: 'done',
      });
    }
  });

  it('expiry and recovery SKIP a row someone else holds instead of waiting for it, and act on it after release', async () => {
    const pending = await newPending(dbOf(0));
    const doomed = await newPending(dbOf(0));
    const store = (i: number) => new AssessmentRunStore({ db: dbOf(i) });
    const token = await store(0).claimRun(doomed, 1);
    expect(token).not.toBeNull();
    await sleep(20);
    const l1 = await holdLock(1, pending);
    const l2 = await holdLock(3, doomed);
    const future = new Date(Date.now() + 3_600_000);
    const started = Date.now();
    expect(await store(2).expirePendingRun(pending, future)).toBe(false);
    expect(await store(2).recoverRun(doomed, new Date())).toBe(false);
    expect(await store(2).recoverExpiredRuns(new Date())).toEqual([]);
    expect(Date.now() - started).toBeLessThan(3_000); // none of the three waited for a lock
    expect(
      (await dbOf(0).select().from(analysisRuns).where(eq(analysisRuns.id, pending)))[0]?.state,
    ).toBe('pending');
    l1.release();
    l2.release();
    await Promise.all([l1.done, l2.done]);
    expect(await store(2).expirePendingRun(pending, future)).toBe(true);
    expect(await store(2).recoverRun(doomed, new Date())).toBe(true);
  });

  it("a claim and an expiry racing on one run end it exactly one way (running with the claimer's lease, or cancelled)", async () => {
    for (let round = 0; round < 10; round += 1) {
      const id = await newPending(dbOf(0));
      const [claim, expired] = await Promise.all([
        new AssessmentRunStore({ db: dbOf(1) }).claimRun(id, 60_000),
        new AssessmentRunStore({ db: dbOf(2) }).expirePendingRun(
          id,
          new Date(Date.now() + 3_600_000),
        ),
      ]);
      const run = (await dbOf(0).select().from(analysisRuns).where(eq(analysisRuns.id, id)))[0];
      // with SKIP LOCKED an expiry that meets the claimer's lock reports `false` and changes nothing
      if (claim !== null) {
        expect(expired).toBe(false);
        expect(run).toMatchObject({ state: 'running', leaseToken: claim });
      } else {
        expect(expired).toBe(true);
        expect(run?.state).toBe('cancelled');
      }
    }
  });
});
