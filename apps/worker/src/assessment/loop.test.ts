import { analysisRuns, assessmentRunCalls, type JudgeDatabase } from '@judge-copilot/database';
import { ScriptedProvider, type LlmProvider } from '@judge-copilot/llm';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AssessmentRunLimits } from '@judge-copilot/schemas';
import { harness, requestRun, seedWorld, testConfig } from '../testing/assessment-world.js';
import { FakeModel } from '../testing/fake-model.js';
import { memoryLogger, testDatabaseTargets, type TestDatabase } from '../testing/harness.js';
import { waitFor } from '../testing/probes.js';
import { createAssessmentLoop, PENDING_MAX_AGE_DEFAULT_MS, type AssessmentLoop } from './loop.js';
import type { RunOutcome } from './pipeline.js';
import { WorkerEnv } from '../env.js';

function loopFor(
  db: JudgeDatabase,
  provider: LlmProvider,
  options: {
    concurrency?: number;
    pendingMaxAgeMs?: number;
    outcomes?: [string, RunOutcome][];
    shutdownGraceMs?: number;
    now?: () => Date;
  } = {},
): AssessmentLoop {
  const h = harness(db);
  const { logger } = memoryLogger();
  return createAssessmentLoop({
    db,
    runs: h.runs,
    logger,
    concurrency: options.concurrency ?? 1,
    pollIntervalMs: 50,
    ...(options.pendingMaxAgeMs === undefined ? {} : { pendingMaxAgeMs: options.pendingMaxAgeMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.shutdownGraceMs === undefined ? {} : { shutdownGraceMs: options.shutdownGraceMs }),
    ...(options.outcomes === undefined
      ? {}
      : { onOutcome: (runId, outcome) => void options.outcomes?.push([runId, outcome]) }),
    pipeline: (() => {
      const { shutdown: _shutdown, ...deps } = h.deps(provider);
      return deps;
    })(),
  });
}

describe('the pending-run timeout is the approved, configurable 15 minutes', () => {
  it('defaults to 15 minutes in the loop and in the environment, and is configurable within bounds', () => {
    expect(PENDING_MAX_AGE_DEFAULT_MS).toBe(15 * 60_000);
    expect(WorkerEnv.parse({}).ASSESSMENT_PENDING_MAX_AGE_MS).toBe(900_000);
    expect(
      WorkerEnv.parse({ ASSESSMENT_PENDING_MAX_AGE_MS: '120000' }).ASSESSMENT_PENDING_MAX_AGE_MS,
    ).toBe(120_000);
    expect(WorkerEnv.safeParse({ ASSESSMENT_PENDING_MAX_AGE_MS: '1000' }).success).toBe(false);
  });

  it('refuses the replay provider in production and without a fixture; defaults the assessment loop off', () => {
    expect(WorkerEnv.parse({}).ASSESSMENT_PROVIDER).toBe('none');
    expect(WorkerEnv.safeParse({ ASSESSMENT_PROVIDER: 'replay' }).success).toBe(false);
    expect(
      WorkerEnv.safeParse({
        ASSESSMENT_PROVIDER: 'replay',
        ASSESSMENT_REPLAY_FIXTURE: 'f.json',
        NODE_ENV: 'production',
      }).success,
    ).toBe(false);
    expect(
      WorkerEnv.safeParse({
        ASSESSMENT_PROVIDER: 'replay',
        ASSESSMENT_REPLAY_FIXTURE: 'f.json',
        NODE_ENV: 'development',
      }).success,
    ).toBe(true);
    // no live provider exists yet
    expect(WorkerEnv.safeParse({ ASSESSMENT_PROVIDER: 'anthropic' }).success).toBe(false);
  });
});

describe.each(testDatabaseTargets())('the assessment loop on %s', (_name, open) => {
  let database: TestDatabase;
  let db: JudgeDatabase;
  beforeAll(async () => {
    database = await open();
    db = database.db;
  });
  afterAll(async () => {
    await database.close();
  });

  /** Runs left pending by a test would be picked up by the next test's loop. */
  afterEach(async () => {
    const h = harness(db);
    const pending = await db
      .select({ id: analysisRuns.id })
      .from(analysisRuns)
      .where(
        sql`${analysisRuns.runType} = 'pre_interview_assessment' AND ${analysisRuns.state} = 'pending'`,
      );
    for (const { id } of pending) {
      await h.runs.finishRun({ runId: id, state: 'cancelled', failureCode: 'test_cleanup' });
    }
  });

  const createdAt = async (runId: string): Promise<number> =>
    (
      await db.select().from(analysisRuns).where(eq(analysisRuns.id, runId))
    )[0]?.createdAt.getTime() ?? 0;

  it('cancels a pending run nobody claimed within the configured age, and only that one', async () => {
    const stale = await seedWorld(db);
    const fresh = await seedWorld(db);
    const provider = new ScriptedProvider([new FakeModel().step], { repeatLast: true });
    const h = harness(db);
    const staleRun = await requestRun(h, stale, provider);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const freshRun = await requestRun(h, fresh, provider);
    // A pending run cannot be edited (the database refuses it), so the clock moves instead: on this clock the first run is 15 min + 50 ms
    // old and the second, created at least 250 ms later, is not yet 15 minutes old.
    const now = new Date((await createdAt(staleRun)) + PENDING_MAX_AGE_DEFAULT_MS + 50);
    const loop = loopFor(db, provider, { now: () => now }); // the DEFAULT age
    expect((await loop.maintain()).expiredPending).toEqual([staleRun]);
    const [a] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, staleRun));
    const [b] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, freshRun));
    expect(a).toMatchObject({ state: 'cancelled', failureCategory: null });
    expect(b?.state).toBe('pending');
    // nothing was spent, the cancellation is recorded, and the project is free again
    expect(
      await db.select().from(assessmentRunCalls).where(eq(assessmentRunCalls.runId, staleRun)),
    ).toHaveLength(0);
    const again = await h.runs.requestAssessment({
      projectId: stale.project.id,
      actorId: stale.actor.id,
      idempotencyKey: `again-${String(Date.now())}-abcdefgh`,
      mode: 'assess',
      target: { kind: 'overall' },
      pipelineConfig: testConfig(provider),
      limits: AssessmentRunLimits.parse({}),
      priceTableId: 'prices/v1',
    });
    expect(again.kind).toBe('run_created');
    // idempotent: a second pass finds nothing more to do
    expect((await loop.maintain()).expiredPending).toEqual([]);
  });

  it('honors a shorter configured age', async () => {
    const world = await seedWorld(db);
    const provider = new ScriptedProvider([new FakeModel().step], { repeatLast: true });
    const runId = await requestRun(harness(db), world, provider);
    const now = new Date((await createdAt(runId)) + 3 * 60_000);
    expect((await loopFor(db, provider, { now: () => now }).maintain()).expiredPending).toEqual([]); // 3 min < 15 min
    expect(
      (await loopFor(db, provider, { now: () => now, pendingMaxAgeMs: 120_000 }).maintain())
        .expiredPending,
    ).toEqual([runId]);
  });

  it('recovers a run whose worker died (lease expired): failed, in-flight attempts counted, nothing re-run', async () => {
    const world = await seedWorld(db);
    const provider = new ScriptedProvider([new FakeModel().step], { repeatLast: true });
    const h = harness(db);
    const runId = await requestRun(h, world, provider);
    expect(await h.runs.claimRun(runId, 1)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { recovered } = await loopFor(db, provider).maintain();
    expect(recovered).toContain(runId);
    const [run] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, runId));
    expect(run).toMatchObject({ state: 'failed', failureCategory: 'internal_error' });
  });

  it('runs pending work to completion (drain), one run at a time by default', async () => {
    const a = await seedWorld(db);
    const b = await seedWorld(db);
    const model = new FakeModel();
    const provider = new ScriptedProvider([model.step], { repeatLast: true });
    const h = harness(db);
    const first = await requestRun(h, a, provider);
    const second = await requestRun(h, b, provider);
    const outcomes: [string, RunOutcome][] = [];
    const started = await loopFor(db, provider, { outcomes }).drain();
    expect(started).toBe(2);
    expect(outcomes.map(([id, o]) => [id, o.kind]).sort()).toEqual(
      [
        [first, 'succeeded'],
        [second, 'succeeded'],
      ].sort(),
    );
  });

  it('two loops (two workers) draining the same pending run execute it exactly once', async () => {
    const world = await seedWorld(db);
    const model = new FakeModel();
    const provider = new ScriptedProvider([model.step], { repeatLast: true });
    const outcomes: [string, RunOutcome][] = [];
    const runId = await requestRun(harness(db), world, provider);
    await Promise.all([
      loopFor(db, provider, { outcomes }).drain(),
      loopFor(db, provider, { outcomes }).drain(),
    ]);
    const kinds = outcomes.map(([, o]) => o.kind);
    expect(kinds.filter((kind) => kind === 'succeeded')).toHaveLength(1);
    expect(kinds.every((kind) => kind === 'succeeded' || kind === 'not_claimed')).toBe(true);
    expect(model.calls).toHaveLength(11);
    const [run] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, runId));
    expect(run?.attemptCount).toBe(1);
  });

  it('bounds concurrency: never more than the configured number of runs, and calls inside a run never overlap', async () => {
    const worlds = [await seedWorld(db), await seedWorld(db), await seedWorld(db)];
    const model = new FakeModel();
    const scripted = new ScriptedProvider([model.step], { repeatLast: true });
    let inFlight = 0;
    let peak = 0;
    const slow: LlmProvider = {
      id: scripted.id,
      mode: scripted.mode,
      async generate(request, signal) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        try {
          return await scripted.generate(request, signal);
        } finally {
          inFlight -= 1;
        }
      },
    };
    const h = harness(db);
    for (const world of worlds) await requestRun(h, world, scripted);
    await loopFor(db, slow, { concurrency: 1 }).drain();
    expect(peak).toBe(1);
    const more = [await seedWorld(db), await seedWorld(db)];
    for (const world of more) await requestRun(h, world, scripted);
    peak = 0;
    await loopFor(db, slow, { concurrency: 2 }).drain();
    expect(peak).toBeLessThanOrEqual(2); // two different runs may overlap; one run never does with itself
  });

  it('stop() waits for in-flight work, then aborts it: the run is cancelled, never left running', async () => {
    const world = await seedWorld(db);
    const model = new FakeModel();
    const scripted = new ScriptedProvider([model.step], { repeatLast: true });
    let started = false;
    const hanging: LlmProvider = {
      id: scripted.id,
      mode: scripted.mode,
      generate(request, signal) {
        if (request.stage !== 'claim_extraction') return scripted.generate(request, signal);
        started = true;
        return new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              resolve({ ok: false, category: 'cancelled', sendState: 'sent_unknown' });
            },
            { once: true },
          );
        });
      },
    };
    const runId = await requestRun(harness(db), world, scripted);
    const outcomes: [string, RunOutcome][] = [];
    const loop = loopFor(db, hanging, { outcomes, shutdownGraceMs: 20 });
    loop.start();
    await waitFor(() => started, 20_000, 'the first model call');
    await loop.stop();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.[1]).toMatchObject({ kind: 'cancelled', code: 'worker_shutdown' });
    const [run] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, runId));
    expect(run?.state).toBe('cancelled');
    expect(loop.inFlight).toBe(0);
  });
});
