import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssessmentRunStore } from './assessment-run-store.js';
import { createDatabase, type DatabaseConnection } from './client.js';
import {
  analysisRuns,
  assessmentRunCalls,
  assessmentRunOutcomes,
  type JudgeDatabase,
} from './index.js';
import { createdRunId, requestInput } from './testing/assessment-fixtures.js';
import { seedAssessmentWorld, type AssessmentWorld } from './testing/assessment-world.js';
import { openPostgres, rows, testDatabaseTargets, type TestDatabase } from './testing/databases.js';

/*
 * Source-review fix 1: the pending-expiry versus worker-claim race.
 *
 * Before the fix the worker loop listed the expired pending runs and then ended each one with `finishRun` WITHOUT a lease token. A
 * worker that claimed the run between the list and the cancel had its live run ended. `expirePendingRun` re-checks `pending` and the
 * age under the run row lock and cancels in the same transaction.
 *
 *   semantics   on both targets, one connection: what the operation does and refuses.
 *   races       on real PostgreSQL only, TWO independent connection pools: every interleaving is forced (a test seam holds the run
 *               lock, the test waits until PostgreSQL reports the competing statement as blocked on a lock, then releases).
 */

const URL_ = process.env['TEST_DATABASE_URL'];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const gate = () => {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
};
const LEASE_MS = 600_000;

async function pendingRun(db: JudgeDatabase, store: AssessmentRunStore, w: AssessmentWorld) {
  const runId = createdRunId(await store.requestAssessment(requestInput(w)));
  const [row] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, runId));
  // every run in these tests counts as "abandoned" for a cutoff one second after its creation
  return { runId, cutoff: new Date((row?.createdAt.getTime() ?? 0) + 1_000) };
}

const stateOf = async (db: JudgeDatabase, runId: string) =>
  (await db.select().from(analysisRuns).where(eq(analysisRuns.id, runId)))[0];
const outcomesOf = (db: JudgeDatabase, runId: string) =>
  db.select().from(assessmentRunOutcomes).where(eq(assessmentRunOutcomes.runId, runId));
const callsOf = (db: JudgeDatabase, runId: string) =>
  db.select().from(assessmentRunCalls).where(eq(assessmentRunCalls.runId, runId));

const world = (db: JudgeDatabase) =>
  seedAssessmentWorld(db, {
    trackKeys: ['health'],
    declare: ['health'],
    rules: [{ statement: 'Every project must be original work.', certainty: 'explicit' }],
  });

describe.each(testDatabaseTargets())('expirePendingRun semantics on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;
  let store: AssessmentRunStore;
  beforeAll(async () => {
    testDb = await open();
    db = testDb.db;
    store = new AssessmentRunStore({ db });
  });
  afterAll(async () => {
    await testDb.close();
  });

  it('D: cancels an abandoned pending run once; a second call changes nothing (idempotent)', async () => {
    const { runId, cutoff } = await pendingRun(db, store, await world(db));
    expect(await store.expirePendingRun(runId, cutoff)).toBe(true);
    expect(await store.expirePendingRun(runId, cutoff)).toBe(false);
    expect(await stateOf(db, runId)).toMatchObject({ state: 'cancelled', failureCategory: null });
    const outcomes = await outcomesOf(db, runId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      outcome: 'cancelled',
      failureCode: 'pending_expired',
      stageReached: 'pending',
    });
  });

  it('E: spends and fabricates nothing: no ledger row, zero totals', async () => {
    const { runId, cutoff } = await pendingRun(db, store, await world(db));
    await store.expirePendingRun(runId, cutoff);
    expect(await callsOf(db, runId)).toHaveLength(0);
    const [outcome] = await outcomesOf(db, runId);
    expect(outcome).toMatchObject({ attemptsStarted: 0, inputTokens: 0, costNanoUsd: 0 });
  });

  it('does not cancel a pending run that is not older than the cutoff (the age is re-checked)', async () => {
    const { runId, cutoff } = await pendingRun(db, store, await world(db));
    const created = new Date(cutoff.getTime() - 1_000);
    expect(await store.expirePendingRun(runId, created)).toBe(false); // exactly as old as the cutoff: not expired
    expect((await stateOf(db, runId))?.state).toBe('pending');
    expect(await outcomesOf(db, runId)).toHaveLength(0);
  });

  it('A (sequential): a run that a worker already claimed is never ended by an expiry pass, whatever the cutoff', async () => {
    const { runId, cutoff } = await pendingRun(db, store, await world(db));
    const token = await store.claimRun(runId, LEASE_MS);
    expect(token).not.toBeNull();
    expect(await store.expirePendingRun(runId, new Date(cutoff.getTime() + 3_600_000))).toBe(false);
    expect(await stateOf(db, runId)).toMatchObject({ state: 'running', leaseToken: token });
    expect(await outcomesOf(db, runId)).toHaveLength(0);
    await store.finishRun({
      runId,
      leaseToken: token ?? '',
      state: 'cancelled',
      failureCode: 'test_cleanup',
    });
  });

  it('B (sequential): once expired, the run cannot be claimed any more', async () => {
    const { runId, cutoff } = await pendingRun(db, store, await world(db));
    await store.expirePendingRun(runId, cutoff);
    expect(await store.claimRun(runId, LEASE_MS)).toBeNull();
    expect((await stateOf(db, runId))?.state).toBe('cancelled');
  });

  it('never touches a terminal run, an unknown run or a run of another type', async () => {
    const { runId, cutoff } = await pendingRun(db, store, await world(db));
    await store.finishRun({ runId, state: 'cancelled', failureCode: 'earlier' });
    expect(await store.expirePendingRun(runId, cutoff)).toBe(false);
    expect((await outcomesOf(db, runId))[0]?.failureCode).toBe('earlier');
    expect(await store.expirePendingRun('00000000-0000-4000-8000-000000000000', cutoff)).toBe(
      false,
    );
  });

  it('F: the explicit lease-recovery path is unchanged: an expired lease is still recovered, a live one is not', async () => {
    const { runId } = await pendingRun(db, store, await world(db));
    const token = await store.claimRun(runId, 1_000);
    expect(token).not.toBeNull();
    const later = new Date(Date.now() + 60_000);
    expect(await store.recoverRun(runId, new Date(Date.now() - 60_000))).toBe(false); // lease still live at that time
    expect(await store.recoverRun(runId, later)).toBe(true);
    expect(await stateOf(db, runId)).toMatchObject({ state: 'failed' });
    expect((await outcomesOf(db, runId))[0]).toMatchObject({ failureCode: 'worker_lease_expired' });
  });
});

describe.skipIf(!URL_)('pending-expiry versus claim races, two connections (PostgreSQL)', () => {
  let setup: Awaited<ReturnType<typeof openPostgres>>;
  let expiryPool: DatabaseConnection;
  let workerPool: DatabaseConnection;
  let db: JudgeDatabase; // the expiry process
  let workerDb: JudgeDatabase; // another worker process

  beforeAll(async () => {
    const url = URL_ ?? '';
    setup = await openPostgres(url);
    expiryPool = createDatabase(url, { maxConnections: 10 });
    workerPool = createDatabase(url, { maxConnections: 10 });
    db = expiryPool.db;
    workerDb = workerPool.db;
  });
  afterAll(async () => {
    await expiryPool.close();
    await workerPool.close();
    await setup.close();
  });

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

  it('A: expiry lists the run, the worker claims (and heartbeats), expiry resumes: the running worker survives', async () => {
    const expiry = new AssessmentRunStore({ db });
    const worker = new AssessmentRunStore({ db: workerDb });
    const { runId, cutoff } = await pendingRun(db, expiry, await world(db));
    // the expiry process has listed `runId` as expired; now the other worker claims it
    const token = await worker.claimRun(runId, LEASE_MS);
    expect(token).not.toBeNull();
    expect(await worker.heartbeat(runId, token ?? '', LEASE_MS)).toBe(true);
    // the expiry process resumes with its stale list
    expect(await expiry.expirePendingRun(runId, cutoff)).toBe(false);
    expect(await stateOf(db, runId)).toMatchObject({ state: 'running', leaseToken: token });
    expect(await outcomesOf(db, runId)).toHaveLength(0);
    expect(await callsOf(db, runId)).toHaveLength(0);
    expect(await worker.heartbeat(runId, token ?? '', LEASE_MS)).toBe(true);
    await worker.finishRun({
      runId,
      leaseToken: token ?? '',
      state: 'cancelled',
      failureCode: 'done',
    });
  });

  it('B: expiry locks the row first and cancels; the worker that tries to claim meanwhile is refused', async () => {
    const entered = gate();
    const release = gate();
    const expiry = new AssessmentRunStore({
      db,
      afterPendingLocked: async () => {
        entered.open();
        await release.wait;
      },
    });
    const worker = new AssessmentRunStore({ db: workerDb });
    const { runId, cutoff } = await pendingRun(db, expiry, await world(db));
    const expiring = expiry.expirePendingRun(runId, cutoff);
    await entered.wait; // the expiry holds the run row lock and has passed its pending/age checks
    const claiming = worker.claimRun(runId, LEASE_MS);
    await waitUntilBlocked(); // the claim is waiting for the lock
    release.open();
    expect(await expiring).toBe(true);
    expect(await claiming).toBeNull();
    expect((await stateOf(db, runId))?.state).toBe('cancelled');
    expect(await outcomesOf(db, runId)).toHaveLength(1);
    expect(await callsOf(db, runId)).toHaveLength(0);
  });

  it('A2: the worker claims first and holds the lock; an expiry started meanwhile waits, then finds a running run and leaves it', async () => {
    const entered = gate();
    const release = gate();
    const workerToken = randomUUID();
    // the claim itself cannot be paused, so the worker's lock is held through a heartbeat-style transaction on the same row
    const expiry = new AssessmentRunStore({ db });
    const worker = new AssessmentRunStore({ db: workerDb });
    const { runId, cutoff } = await pendingRun(db, expiry, await world(db));
    const holding = workerDb.transaction(async (tx) => {
      await tx.select().from(analysisRuns).where(eq(analysisRuns.id, runId)).for('update');
      entered.open();
      await release.wait;
      await tx
        .update(analysisRuns)
        .set({
          state: 'running',
          startedAt: new Date(),
          leaseToken: workerToken,
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
          attemptCount: 1,
        })
        .where(eq(analysisRuns.id, runId));
    });
    await entered.wait;
    const expiring = expiry.expirePendingRun(runId, cutoff);
    await waitUntilBlocked();
    release.open();
    await holding;
    expect(await expiring).toBe(false); // the age and state were re-read after the lock was granted
    expect(await stateOf(db, runId)).toMatchObject({ state: 'running', leaseToken: workerToken });
    expect(await outcomesOf(db, runId)).toHaveLength(0);
    expect(await worker.heartbeat(runId, workerToken, LEASE_MS)).toBe(true);
    await worker.finishRun({
      runId,
      leaseToken: workerToken,
      state: 'cancelled',
      failureCode: 'done',
    });
  });

  it('C: heartbeats racing with expiry passes and a lease recovery never let anyone end a claimed run', async () => {
    const expiry = new AssessmentRunStore({ db });
    const worker = new AssessmentRunStore({ db: workerDb });
    const { runId, cutoff } = await pendingRun(db, expiry, await world(db));
    const token = (await worker.claimRun(runId, LEASE_MS)) ?? '';
    expect(token).not.toBe('');
    const results = await Promise.all([
      expiry.expirePendingRun(runId, cutoff),
      worker.heartbeat(runId, token, LEASE_MS),
      expiry.expirePendingRun(runId, new Date(Date.now() + 3_600_000)),
      worker.heartbeat(runId, token, LEASE_MS),
      expiry.recoverRun(runId, new Date()), // the lease is live: nothing to recover
      expiry.expirePendingRun(runId, cutoff),
    ]);
    expect(results).toEqual([false, true, false, true, false, false]);
    expect(await stateOf(db, runId)).toMatchObject({ state: 'running', leaseToken: token });
    expect(await outcomesOf(db, runId)).toHaveLength(0);
    await worker.finishRun({ runId, leaseToken: token, state: 'cancelled', failureCode: 'done' });
  });

  it('D: two expiry processes racing on one abandoned run: exactly one cancels, one outcome row', async () => {
    const first = new AssessmentRunStore({ db });
    const second = new AssessmentRunStore({ db: workerDb });
    const { runId, cutoff } = await pendingRun(db, first, await world(db));
    const results = await Promise.all([
      first.expirePendingRun(runId, cutoff),
      second.expirePendingRun(runId, cutoff),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await outcomesOf(db, runId)).toHaveLength(1);
  });

  it('claim and expiry racing on many runs: every run ends in exactly one consistent state', async () => {
    const expiry = new AssessmentRunStore({ db });
    const worker = new AssessmentRunStore({ db: workerDb });
    for (let round = 0; round < 12; round += 1) {
      const { runId, cutoff } = await pendingRun(db, expiry, await world(db));
      const [claimed, expired] = await Promise.all([
        worker.claimRun(runId, LEASE_MS),
        expiry.expirePendingRun(runId, cutoff),
      ]);
      const run = await stateOf(db, runId);
      if (claimed !== null) {
        expect(expired).toBe(false);
        expect(run).toMatchObject({ state: 'running', leaseToken: claimed });
        expect(await outcomesOf(db, runId)).toHaveLength(0);
        await worker.finishRun({
          runId,
          leaseToken: claimed,
          state: 'cancelled',
          failureCode: 'done',
        });
      } else {
        expect(expired).toBe(true);
        expect(run?.state).toBe('cancelled');
        expect(await outcomesOf(db, runId)).toHaveLength(1);
      }
    }
  });
});
