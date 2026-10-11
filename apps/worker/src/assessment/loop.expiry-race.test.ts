import {
  analysisRuns,
  assessmentRunCalls,
  assessmentRunOutcomes,
  AssessmentRunStore,
  type JudgeDatabase,
} from '@judge-copilot/database';
import { ScriptedProvider } from '@judge-copilot/llm';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness, requestRun, seedWorld } from '../testing/assessment-world.js';
import { FakeModel } from '../testing/fake-model.js';
import { memoryLogger, testDatabaseTargets, type TestDatabase } from '../testing/harness.js';
import { createAssessmentLoop, PENDING_MAX_AGE_DEFAULT_MS } from './loop.js';
import { runAssessment } from './pipeline.js';

/*
 * Source-review fix 1 at the level of the worker: the pending-expiry pass versus a worker that claims the same run.
 *
 * The loop LISTS expired pending runs and then asks the store to expire each one. `HookedStore` pauses the expiry of a run after the
 * list was made, which is exactly the window the race used: another worker claims in that window. Before the fix the loop then ended
 * the RUNNING run (a tokenless `finishRun`); these tests failed on that code with "expected 'cancelled' to be 'running'".
 */

const gate = () => {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
};

class HookedStore extends AssessmentRunStore {
  /** Awaited after the loop selected the run and before the store is asked to expire it. */
  beforeExpire: (runId: string) => Promise<void> = () => Promise.resolve();
  override async expirePendingRun(runId: string, createdBefore: Date): Promise<boolean> {
    await this.beforeExpire(runId);
    return super.expirePendingRun(runId, createdBefore);
  }
}

describe.each(testDatabaseTargets())(
  'pending expiry versus claim in the loop on %s',
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

    async function setup() {
      const world = await seedWorld(db);
      const model = new FakeModel();
      const provider = new ScriptedProvider([model.step], { repeatLast: true });
      const h = harness(db);
      const runId = await requestRun(h, world, provider);
      const [row] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, runId));
      const now = new Date((row?.createdAt.getTime() ?? 0) + PENDING_MAX_AGE_DEFAULT_MS + 50);
      const hooked = new HookedStore({ db });
      const { logger } = memoryLogger();
      const { shutdown: _shutdown, ...pipeline } = h.deps(provider);
      const loop = createAssessmentLoop({
        db,
        runs: hooked,
        logger,
        concurrency: 1,
        pollIntervalMs: 50,
        now: () => now,
        pipeline: { ...pipeline, runs: hooked },
      });
      return { h, runId, hooked, loop, provider, model, deps: h.deps(provider) };
    }
    const stateOf = async (runId: string) =>
      (await db.select().from(analysisRuns).where(eq(analysisRuns.id, runId)))[0];

    it('A: the loop selected the run, a worker claims (and heartbeats), the loop resumes: the running run survives', async () => {
      const { h, runId, hooked, loop } = await setup();
      const entered = gate();
      const release = gate();
      hooked.beforeExpire = async () => {
        entered.open();
        await release.wait;
      };
      const maintaining = loop.maintain();
      await entered.wait;
      const token = await h.runs.claimRun(runId, 300_000);
      expect(token).not.toBeNull();
      expect(await h.runs.heartbeat(runId, token ?? '', 300_000)).toBe(true);
      release.open();
      expect((await maintaining).expiredPending).toEqual([]);
      expect(await stateOf(runId)).toMatchObject({ state: 'running', leaseToken: token });
      expect(
        await db.select().from(assessmentRunOutcomes).where(eq(assessmentRunOutcomes.runId, runId)),
      ).toHaveLength(0);
      // the worker still owns the run: only its token can end it
      await h.runs.finishRun({
        runId,
        leaseToken: token ?? '',
        state: 'cancelled',
        failureCode: 'test_cleanup',
      });
    });

    it('A (whole pipeline): a real worker that claimed the run is not disturbed by the resuming expiry and completes its own terminal write', async () => {
      const { runId, hooked, loop, deps } = await setup();
      const entered = gate();
      const release = gate();
      hooked.beforeExpire = async () => {
        entered.open();
        await release.wait;
      };
      const maintaining = loop.maintain();
      await entered.wait;
      // the worker claims and runs to its end while the expiry is paused with its stale list; it fails at a model-free stage
      const outcome = await runAssessment({ ...deps, runs: hooked }, runId);
      release.open();
      expect((await maintaining).expiredPending).toEqual([]);
      expect(outcome.kind).not.toBe('lost');
      expect(outcome.kind).not.toBe('not_claimed');
      const [row] = await db
        .select()
        .from(assessmentRunOutcomes)
        .where(eq(assessmentRunOutcomes.runId, runId));
      expect(row?.failureCode).not.toBe('pending_expired');
    });

    it('B: the loop expires the run first; a worker that then tries to claim it is refused and nothing is spent', async () => {
      const { runId, loop, model, deps, hooked } = await setup();
      expect((await loop.maintain()).expiredPending).toEqual([runId]);
      expect(await runAssessment({ ...deps, runs: hooked }, runId)).toEqual({
        kind: 'not_claimed',
      });
      expect(await stateOf(runId)).toMatchObject({ state: 'cancelled' });
      expect(model.calls).toHaveLength(0);
      expect(
        await db.select().from(assessmentRunCalls).where(eq(assessmentRunCalls.runId, runId)),
      ).toHaveLength(0);
    });

    it('D/E: expiring twice is idempotent and fabricates no second outcome', async () => {
      const { runId, loop } = await setup();
      expect((await loop.maintain()).expiredPending).toEqual([runId]);
      expect((await loop.maintain()).expiredPending).toEqual([]);
      const outcomes = await db
        .select()
        .from(assessmentRunOutcomes)
        .where(eq(assessmentRunOutcomes.runId, runId));
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ failureCode: 'pending_expired', attemptsStarted: 0 });
    });
  },
);
