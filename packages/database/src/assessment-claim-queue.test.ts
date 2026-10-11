import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssessmentRunStore } from './assessment-run-store.js';
import { createDatabase, type DatabaseConnection } from './client.js';
import { analysisRuns, type JudgeDatabase } from './index.js';
import { createdRunId, requestInput } from './testing/assessment-fixtures.js';
import { seedAssessmentWorld } from './testing/assessment-world.js';
import { openPostgres, rows } from './testing/databases.js';

/*
 * Source-review item 3: what the worker queue's claim guarantees TODAY. The loop lists pending run ids (a plain SELECT) and each worker
 * then calls `claimRun`, which takes `SELECT ... FOR UPDATE` (blocking) on that ONE row and re-checks `pending`. The approved design
 * names `FOR UPDATE SKIP LOCKED`. These tests pin down what the present mechanism does and does not do, on real PostgreSQL with
 * independent connection pools:
 *
 *   no duplicate execution   N workers racing over the same ordered list claim every run exactly once.
 *   row-scoped blocking      a claim waits only for the holder of THAT row's lock; a claim of another pending run is not delayed.
 *   what it is not           a claim of a row whose lock is held WAITS (it does not skip); it is bounded by the holder's transaction.
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

describe.skipIf(!URL_)('queue claim semantics with competing workers (PostgreSQL)', () => {
  let setup: Awaited<ReturnType<typeof openPostgres>>;
  const pools: DatabaseConnection[] = [];
  const dbOf = (i: number): JudgeDatabase => pools[i]?.db as JudgeDatabase;

  beforeAll(async () => {
    const url = URL_ ?? '';
    setup = await openPostgres(url);
    for (let i = 0; i < 4; i += 1) pools.push(createDatabase(url, { maxConnections: 6 }));
  });
  afterAll(async () => {
    for (const pool of pools) await pool.close();
    await setup.close();
  });

  const newPending = async (): Promise<string> => {
    const w = await seedAssessmentWorld(dbOf(0), {
      trackKeys: ['health'],
      declare: ['health'],
      rules: [{ statement: 'Every project must be original work.', certainty: 'explicit' }],
    });
    return createdRunId(
      await new AssessmentRunStore({ db: dbOf(0) }).requestAssessment(requestInput(w)),
    );
  };

  async function waitUntilBlocked(): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const [row] = await rows<{ n: number }>(
        dbOf(0),
        sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`,
      );
      if ((row?.n ?? 0) >= 1) return;
      await sleep(15);
    }
    throw new Error('the competing statement never became blocked on a lock');
  }

  it('three workers sweeping the same ordered list claim every run exactly once (no duplicate execution)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 9; i += 1) ids.push(await newPending());
    const claimed: [number, string, string][] = [];
    await Promise.all(
      [1, 2, 3].map(async (worker) => {
        const store = new AssessmentRunStore({ db: dbOf(worker) });
        for (const id of ids) {
          const token = await store.claimRun(id, 300_000);
          if (token !== null) claimed.push([worker, id, token]);
        }
      }),
    );
    expect(claimed.map(([, id]) => id).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const [run] = await dbOf(0).select().from(analysisRuns).where(eq(analysisRuns.id, id));
      expect(run).toMatchObject({ state: 'running', attemptCount: 1 });
      expect(run?.leaseToken).toBe(claimed.find(([, runId]) => runId === id)?.[2]);
    }
    for (const [, id, token] of claimed) {
      await new AssessmentRunStore({ db: dbOf(0) }).finishRun({
        runId: id,
        leaseToken: token,
        state: 'cancelled',
        failureCode: 'done',
      });
    }
  });

  it('blocking is scoped to one row: a held lock delays the claim of THAT run only; it waits (does not skip) and then sees the final state', async () => {
    const held = await newPending();
    const other = await newPending();
    const entered = gate();
    const release = gate();
    const holder = dbOf(1).transaction(async (tx) => {
      await tx.select().from(analysisRuns).where(eq(analysisRuns.id, held)).for('update');
      entered.open();
      await release.wait;
    });
    await entered.wait;
    const store = new AssessmentRunStore({ db: dbOf(2) });
    const waiting = store.claimRun(held, 300_000);
    await waitUntilBlocked(); // the claim of the locked row waits
    const token = await new AssessmentRunStore({ db: dbOf(3) }).claimRun(other, 300_000);
    expect(token).not.toBeNull(); // another pending run is claimed meanwhile
    release.open();
    await holder;
    const heldToken = await waiting;
    expect(heldToken).not.toBeNull(); // the holder only read the row: the waiting claim wins afterwards
    for (const [id, t] of [
      [held, heldToken],
      [other, token],
    ] as const) {
      await store.finishRun({
        runId: id,
        leaseToken: t ?? '',
        state: 'cancelled',
        failureCode: 'done',
      });
    }
  });
});
