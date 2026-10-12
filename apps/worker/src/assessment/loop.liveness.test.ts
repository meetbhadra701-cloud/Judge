import {
  analysisRuns,
  createDatabase,
  type DatabaseConnection,
  type JudgeDatabase,
} from '@judge-copilot/database';
import { ScriptedProvider } from '@judge-copilot/llm';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, requestRun, seedWorld } from '../testing/assessment-world.js';
import { FakeModel } from '../testing/fake-model.js';
import { memoryLogger, testDatabaseTargets, type TestDatabase } from '../testing/harness.js';
import { waitFor } from '../testing/probes.js';
import { createAssessmentLoop, type AssessmentLoop } from './loop.js';

/*
 * P6A queue liveness (R5 F-1), on REAL PostgreSQL with independent connection pools. Before the fix these tests reproduce the
 * starvation the R5 review demonstrated: one held row lock on the oldest pending run froze the whole worker (the claim waited on the
 * lock), froze the maintenance pass when the run was past the pending limit, and made `stop()` wait for the lock. They are
 * PostgreSQL-only because PGlite has a single connection and cannot hold a lock another session waits on.
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

describe.skipIf(!URL_)('queue liveness under a held row lock (PostgreSQL)', () => {
  let setup: TestDatabase;
  const pools: DatabaseConnection[] = [];
  const dbOf = (index: number): JudgeDatabase => pools[index]?.db as JudgeDatabase;
  const loops: AssessmentLoop[] = [];
  const held: (() => void)[] = [];
  // a failing test must never leave a lock behind
  afterEach(async () => {
    for (const release of held.splice(0)) release();
    for (const loop of loops.splice(0)) await loop.stop().catch(() => undefined);
    for (const pool of pools.splice(0)) await pool.close();
    await setup.close();
  });

  // every test gets a freshly migrated database and fresh pools: leftovers of one test must not be work for the next
  beforeEach(async () => {
    const target = testDatabaseTargets()[1];
    if (!target) throw new Error('TEST_DATABASE_URL required');
    setup = await target[1]();
    // 0: seeding and observation, 1-2: two workers, 3: the lock holder
    for (let i = 0; i < 4; i += 1) pools.push(createDatabase(URL_ ?? '', { maxConnections: 6 }));
  });

  const provider = () => new ScriptedProvider([new FakeModel().step], { repeatLast: true });

  async function makeRuns(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const world = await seedWorld(dbOf(0));
      ids.push(await requestRun(harness(dbOf(0)), world, provider()));
      await sleep(15); // distinct created_at, so the order is the creation order
    }
    return ids;
  }

  const stateOf = async (id: string) =>
    (await dbOf(0).select().from(analysisRuns).where(eq(analysisRuns.id, id)))[0]?.state;
  const statesOf = async (ids: string[]) => {
    const rows = await dbOf(0).select().from(analysisRuns).where(inArray(analysisRuns.id, ids));
    return ids.map((id) => rows.find((row) => row.id === id)?.state);
  };

  /** Holds `FOR UPDATE` on a run row from another connection until `release()`. */
  async function holdLock(index: number, runId: string) {
    const release = gate();
    let acquired: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const done = dbOf(index).transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM analysis_runs WHERE id = ${runId} FOR UPDATE`);
      acquired();
      await release.wait;
    });
    await locked;
    held.push(release.open);
    return { release: release.open, done };
  }

  function makeLoop(index: number, concurrency: number, extra: { shutdownGraceMs?: number } = {}) {
    const db = dbOf(index);
    const h = harness(db);
    const { logger } = memoryLogger();
    const { shutdown: _shutdown, ...deps } = h.deps(provider());
    const loop = createAssessmentLoop({
      db,
      runs: h.runs,
      logger,
      concurrency,
      pollIntervalMs: 40,
      shutdownGraceMs: extra.shutdownGraceMs ?? 200,
      pipeline: deps,
    });
    loops.push(loop);
    return loop;
  }

  /** The integrity trigger forbids editing a pending run; it is disabled for this one test-only UPDATE. */
  async function backdate(runId: string): Promise<void> {
    await dbOf(0).transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE analysis_runs DISABLE TRIGGER USER`);
      await tx.execute(
        sql`UPDATE analysis_runs SET created_at = now() - interval '2 hours' WHERE id = ${runId}`,
      );
      await tx.execute(sql`ALTER TABLE analysis_runs ENABLE TRIGGER USER`);
    });
  }

  it('concurrency 1: the oldest pending run is locked by another session; the later runs still complete, and the locked one completes after release', async () => {
    const ids = await makeRuns(3);
    const lock = await holdLock(3, ids[0] as string);
    const loop = makeLoop(1, 1);
    loop.start();
    await waitFor(async () => (await stateOf(ids[1] as string)) === 'succeeded', 20_000, 'run 2');
    await waitFor(async () => (await stateOf(ids[2] as string)) === 'succeeded', 20_000, 'run 3');
    expect(await stateOf(ids[0] as string)).toBe('pending');
    lock.release();
    await lock.done;
    await waitFor(async () => (await stateOf(ids[0] as string)) === 'succeeded', 20_000, 'run 1');
    await loop.stop();
  }, 90_000);

  it('concurrency 2: two locked oldest runs do not occupy the slots; the third completes', async () => {
    const ids = await makeRuns(3);
    const l1 = await holdLock(3, ids[0] as string);
    const l2 = await holdLock(2, ids[1] as string);
    const loop = makeLoop(1, 2);
    loop.start();
    await waitFor(async () => (await stateOf(ids[2] as string)) === 'succeeded', 20_000, 'run 3');
    l1.release();
    l2.release();
    await Promise.all([l1.done, l2.done]);
    await waitFor(
      async () => (await statesOf(ids)).every((state) => state === 'succeeded'),
      30_000,
      'all runs',
    );
    await loop.stop();
  }, 90_000);

  it('maintenance progresses: a locked head run past the pending limit does not stop the claiming of younger runs, and it is expired after release', async () => {
    const ids = await makeRuns(3);
    await backdate(ids[0] as string);
    const lock = await holdLock(3, ids[0] as string);
    const loop = makeLoop(1, 2);
    loop.start();
    await waitFor(async () => (await stateOf(ids[1] as string)) === 'succeeded', 20_000, 'run 2');
    await waitFor(async () => (await stateOf(ids[2] as string)) === 'succeeded', 20_000, 'run 3');
    expect(await stateOf(ids[0] as string)).toBe('pending');
    lock.release();
    await lock.done;
    await waitFor(async () => (await stateOf(ids[0] as string)) === 'cancelled', 20_000, 'expiry');
    await loop.stop();
  }, 90_000);

  it('lease recovery progresses while a past-limit pending run is locked (the maintenance pass must not stall behind it)', async () => {
    const [pending, doomed] = await makeRuns(2);
    await backdate(pending as string);
    // a worker "crashes" holding a short lease that nobody renews: it expires AFTER the loop's first maintenance pass has begun
    expect(await harness(dbOf(0)).runs.claimRun(doomed as string, 800)).not.toBeNull();
    const lock = await holdLock(3, pending as string);
    const loop = makeLoop(1, 1);
    loop.start();
    await waitFor(async () => (await stateOf(doomed as string)) === 'failed', 20_000, 'recovery');
    lock.release();
    await lock.done;
  }, 90_000);

  it('stop() completes while the head run is locked (the blocked claim must not wedge shutdown)', async () => {
    const ids = await makeRuns(2);
    const lock = await holdLock(3, ids[0] as string);
    const loop = makeLoop(1, 1, { shutdownGraceMs: 100 });
    loop.start();
    await sleep(600);
    const stopped = await Promise.race([
      loop.stop().then(() => 'stopped'),
      sleep(5_000).then(() => 'STILL BLOCKED'),
    ]);
    expect(stopped).toBe('stopped');
    lock.release();
    await lock.done;
  }, 60_000);

  it('two workers over one locked head run: the others complete exactly once each (no duplicate claim, no loss)', async () => {
    const ids = await makeRuns(4);
    const lock = await holdLock(3, ids[0] as string);
    const a = makeLoop(1, 1);
    const b = makeLoop(2, 1);
    a.start();
    b.start();
    await waitFor(
      async () => (await statesOf(ids.slice(1))).every((state) => state === 'succeeded'),
      30_000,
      'later runs',
    );
    lock.release();
    await lock.done;
    await waitFor(
      async () => (await stateOf(ids[0] as string)) === 'succeeded',
      30_000,
      'head run',
    );
    const rows = await dbOf(0).select().from(analysisRuns).where(inArray(analysisRuns.id, ids));
    expect(rows.every((row) => row.attemptCount === 1)).toBe(true);
    await Promise.all([a.stop(), b.stop()]);
  }, 120_000);
});
