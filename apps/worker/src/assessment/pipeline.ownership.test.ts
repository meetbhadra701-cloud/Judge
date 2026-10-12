import {
  analysisRuns,
  assessmentRunCalls,
  assessmentRunExtractions,
  graphExtractions,
  claims,
  type JudgeDatabase,
} from '@judge-copilot/database';
import { systemClock, type Clock, type LlmProvider } from '@judge-copilot/llm';
import type { AssessmentStage } from '@judge-copilot/schemas';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness, requestRun, seedWorld } from '../testing/assessment-world.js';
import { FakeModel } from '../testing/fake-model.js';
import { testDatabaseTargets, type TestDatabase } from '../testing/harness.js';
import { waitFor } from '../testing/probes.js';
import { execute, expectNoAssessment } from '../testing/run.js';
import { ScriptedProvider } from '@judge-copilot/llm';
import { runAssessment } from './pipeline.js';

const CANCELLED = { ok: false, category: 'cancelled', sendState: 'sent_unknown' } as const;
const FAR_FUTURE = new Date(Date.now() + 10 * 365 * 86_400_000);

/** A clock whose timers never fire: the process behind it is "dead" as far as heartbeats and deadlines go. */
const deadClock: Clock = { ...systemClock, after: () => () => undefined };

/** Calls `hook` (once) before the Nth call of `stage`, then the real provider; if `hook` returns 'hang' the call never answers until aborted. */
function onCall(
  stage: AssessmentStage,
  hook: (request: Parameters<LlmProvider['generate']>[0]) => Promise<'hang' | undefined>,
  nth = 1,
) {
  return (inner: LlmProvider): LlmProvider => {
    let seen = 0;
    return {
      id: inner.id,
      mode: inner.mode,
      async generate(request, signal) {
        if (request.stage === stage) {
          seen += 1;
          if (seen === nth && (await hook(request)) === 'hang') {
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else
                signal.addEventListener(
                  'abort',
                  () => {
                    resolve();
                  },
                  { once: true },
                );
            });
            return CANCELLED;
          }
        }
        return inner.generate(request, signal);
      },
    };
  };
}

describe.each(testDatabaseTargets())(
  'run ownership, shutdown and extraction reuse on %s',
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

    describe('a crash between the extraction and the assessment', () => {
      it('leaves a complete, reusable extraction; a new run reuses it and only the assessment is paid for again', async () => {
        const world = await seedWorld(db);
        // -- run 1: the worker dies inside the first assessor call (its timers never fire, the call never answers) ---------------
        const first = new AbortController();
        const model1 = new FakeModel();
        let runId1 = '';
        const crashed = execute(db, {
          world,
          model: model1,
          wrap: onCall('dimension_assessment', () => Promise.resolve('hang')),
          deps: { clock: deadClock, leaseMs: 40, shutdown: first.signal },
        });
        await waitFor(
          async () =>
            (
              await db
                .select()
                .from(analysisRuns)
                .where(eq(analysisRuns.projectId, world.project.id))
            ).length > 0,
        );
        await waitFor(() => model1.callsOf('relation_verification').length > 0);
        await waitFor(
          async () =>
            (
              await db
                .select()
                .from(assessmentRunCalls)
                .where(eq(assessmentRunCalls.stage, 'dimension_assessment'))
            ).length > 0,
        );
        // the lease (40 ms, never renewed) expires; the recovery pass fails the run and counts the in-flight attempt at its worst case
        await new Promise((resolve) => setTimeout(resolve, 80));
        const h0 = harness(db);
        const recovered = await h0.runs.recoverExpiredRuns(new Date());
        expect(recovered).toHaveLength(1);
        runId1 = recovered[0] ?? '';
        first.abort(); // lets the abandoned promise end; it must not write anything about a run it no longer owns
        const crashedResult = await crashed;
        expect(crashedResult.outcome.kind).toBe('lost');

        const [failed] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, runId1));
        expect(failed).toMatchObject({ state: 'failed', failureCategory: 'internal_error' });
        const inFlight = await db
          .select()
          .from(assessmentRunCalls)
          .where(eq(assessmentRunCalls.runId, runId1));
        expect(inFlight.filter((call) => call.state === 'unknown')).toHaveLength(1);
        await expectNoAssessment(crashedResult, db);
        const claimsAfterCrash = await db
          .select()
          .from(claims)
          .where(eq(claims.projectId, world.project.id));
        expect(claimsAfterCrash.length).toBeGreaterThan(0);

        // -- run 2: the same project, a new request: the extraction is found by its identity and reused -------------------------
        const model2 = new FakeModel();
        const second = await execute(db, { world, model: model2 });
        expect(second.outcome.kind).toBe('succeeded');
        // no extraction stage was called again: only the 2 assessor and 2 critic calls were paid for
        expect(model2.calls.map((call) => call.stage).sort()).toEqual([
          'critic',
          'critic',
          'dimension_assessment',
          'dimension_assessment',
        ]);
        const bound1 = await db
          .select()
          .from(assessmentRunExtractions)
          .where(eq(assessmentRunExtractions.runId, runId1));
        const bound2 = await db
          .select()
          .from(assessmentRunExtractions)
          .where(eq(assessmentRunExtractions.runId, second.runId));
        expect(bound1).toHaveLength(2);
        const idsOf = (rows: typeof bound1) =>
          rows.map((r) => `${r.kind}:${r.extractionId}`).sort();
        expect(idsOf(bound2)).toEqual(idsOf(bound1));
        // nothing was written twice
        const claimsAfter = await db
          .select()
          .from(claims)
          .where(eq(claims.projectId, world.project.id));
        expect(claimsAfter).toHaveLength(claimsAfterCrash.length);
        const extractions = await db
          .select()
          .from(graphExtractions)
          .where(eq(graphExtractions.projectId, world.project.id));
        expect(extractions).toHaveLength(2);
        const [assessment] = await second.assessments();
        const limitations = assessment?.limitations as { code: string }[];
        expect(limitations.map((l) => l.code)).toContain('extraction_reused');
      });

      it('never reuses an extraction across a different configuration (a different extraction model is a new extraction)', async () => {
        const world = await seedWorld(db);
        const a = await execute(db, { world });
        expect(a.outcome.kind).toBe('succeeded');
        // a re-assessment that asks for the same work is the same extraction ...
        const b = await execute(db, { world, model: new FakeModel(), mode: 'reassess' });
        expect(b.model.callsOf('claim_extraction')).toHaveLength(0);
        // ... a different model for the extraction stages is not
        const model = new FakeModel();
        const c = await execute(db, {
          world,
          model,
          models: {
            models: {
              extraction: 'claude-sonnet-5-5',
              assessment: 'claude-sonnet-5-5',
              critic: 'claude-sonnet-5-5',
            },
          },
        });
        expect(c.outcome.kind).toBe('succeeded');
        expect(model.callsOf('claim_extraction')).toHaveLength(1);
        const extractions = await db
          .select()
          .from(graphExtractions)
          .where(eq(graphExtractions.projectId, world.project.id));
        expect(extractions.filter((e) => e.kind === 'source')).toHaveLength(2);
      });
    });

    describe('lease ownership', () => {
      it('heartbeats keep a long call alive: the lease is renewed while the model works', async () => {
        const world = await seedWorld(db);
        let before: Date | null = null;
        let during: Date | null = null;
        let recoveredWhileRunning: string[] = ['untested'];
        const run = await execute(db, {
          world,
          wrap: onCall('claim_extraction', async () => {
            const probe = async () =>
              (
                await db
                  .select()
                  .from(analysisRuns)
                  .where(eq(analysisRuns.projectId, world.project.id))
              )[0]?.leaseExpiresAt ?? null;
            before = await probe();
            // three times the lease: only renewals can keep the run alive
            await new Promise((resolve) => setTimeout(resolve, 900));
            recoveredWhileRunning = await harness(db).runs.recoverExpiredRuns(new Date());
            during = await probe();
            return undefined;
          }),
          deps: { leaseMs: 300, heartbeatEveryMs: 40 },
        });
        expect(run.outcome.kind).toBe('succeeded');
        expect(recoveredWhileRunning).toEqual([]);
        expect((during as Date | null)?.getTime() ?? 0).toBeGreaterThan(
          (before as Date | null)?.getTime() ?? 0,
        );
      });

      it('stops at once when the lease is lost: the in-flight call is aborted and the worker writes nothing more', async () => {
        const world = await seedWorld(db);
        const model = new FakeModel();
        let stolen = '';
        const run = await execute(db, {
          world,
          model,
          wrap: onCall('dimension_assessment', async () => {
            const [row] = await db
              .select()
              .from(analysisRuns)
              .where(eq(analysisRuns.projectId, world.project.id));
            stolen = row?.id ?? '';
            // another worker's recovery pass takes the run over (fails it, counts the in-flight attempt)
            // recovery skips a row someone else holds at this instant (here: the 20 ms heartbeat) and the next maintenance pass
            // retries it, so the test retries too
            for (let attempt = 0; attempt < 200; attempt += 1) {
              if (await harness(db).runs.recoverRun(stolen, FAR_FUTURE)) break;
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            return 'hang';
          }),
          deps: { leaseMs: 60_000, heartbeatEveryMs: 20 },
        });
        expect(run.outcome.kind).toBe('lost');
        // the recovery's terminal state stands: the worker did not overwrite it
        const [row] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, stolen));
        expect(row).toMatchObject({ state: 'failed', failureCategory: 'internal_error' });
        expect((await run.outcomeRow())?.failureCode).toBe('worker_lease_expired');
        await expectNoAssessment(run, db);
        // no model call started after the lease was lost
        expect(model.callsOf('dimension_assessment')).toHaveLength(0);
        expect(model.callsOf('critic')).toHaveLength(0);
      });

      it('cannot persist with a stale lease token: the stale worker leaves no assessment', async () => {
        const world = await seedWorld(db);
        const run = await execute(db, {
          world,
          // after the LAST critic call the token changes (as if another worker had claimed the run)
          wrap: onCall(
            'critic',
            async () => {
              await db.execute(
                sql`UPDATE analysis_runs SET lease_token = gen_random_uuid() WHERE project_id = ${world.project.id} AND state = 'running'`,
              );
              return undefined;
            },
            2,
          ),
          deps: { leaseMs: 60_000, heartbeatEveryMs: 60_000 },
        });
        expect(run.outcome.kind).toBe('lost');
        await expectNoAssessment(run, db);
        expect((await run.run())?.state).toBe('running'); // the new owner's, untouched by this worker
      });

      it('honors an operator cancellation: the heartbeat sees the run ended and the worker stops without rewriting it', async () => {
        const world = await seedWorld(db);
        const model = new FakeModel();
        const run = await execute(db, {
          world,
          model,
          wrap: onCall('claim_extraction', async () => {
            const [row] = await db
              .select()
              .from(analysisRuns)
              .where(eq(analysisRuns.projectId, world.project.id));
            await harness(db).runs.finishRun({
              runId: row?.id ?? '',
              state: 'cancelled',
              failureCode: 'operator_cancelled',
              stageReached: 'extract',
            });
            return 'hang';
          }),
          deps: { leaseMs: 60_000, heartbeatEveryMs: 20 },
        });
        expect(run.outcome.kind).toBe('lost');
        expect((await run.run())?.state).toBe('cancelled');
        expect((await run.outcomeRow())?.failureCode).toBe('operator_cancelled');
        expect(model.calls).toHaveLength(0);
      });
    });

    describe('a worker that no longer owns the run', () => {
      it("cannot cancel or fail it: a shutdown with a stale lease token leaves the new owner's run untouched", async () => {
        const world = await seedWorld(db);
        const shutdown = new AbortController();
        const run = await execute(db, {
          world,
          wrap: onCall('claim_extraction', async () => {
            // another worker now holds the run (new token) ...
            await db.execute(
              sql`UPDATE analysis_runs SET lease_token = gen_random_uuid() WHERE project_id = ${world.project.id} AND state = 'running'`,
            );
            // ... and only then does this worker learn it is shutting down
            shutdown.abort();
            return 'hang';
          }),
          deps: { shutdown: shutdown.signal, leaseMs: 60_000, heartbeatEveryMs: 60_000 },
        });
        expect(run.outcome.kind).toBe('lost');
        expect((await run.run())?.state).toBe('running');
        expect(await run.outcomeRow()).toBeUndefined();
      });
    });

    describe('shutdown', () => {
      it('aborts the in-flight call and cancels the run; the attempt stays counted at its worst case', async () => {
        const world = await seedWorld(db);
        const shutdown = new AbortController();
        const model = new FakeModel();
        const run = await execute(db, {
          world,
          model,
          wrap: onCall('claim_extraction', () => {
            shutdown.abort();
            return Promise.resolve('hang');
          }),
          deps: { shutdown: shutdown.signal },
        });
        expect(run.outcome).toMatchObject({ kind: 'cancelled', code: 'worker_shutdown' });
        expect(await run.run()).toMatchObject({ state: 'cancelled', failureCategory: null });
        expect(await run.outcomeRow()).toMatchObject({
          outcome: 'cancelled',
          failureCode: 'worker_shutdown',
        });
        const calls = await run.calls();
        expect(calls).toHaveLength(1);
        expect(calls[0]?.state).toBe('unknown');
        expect(model.calls).toHaveLength(0);
        await expectNoAssessment(run, db);
      });

      it('a shutdown already in progress when the run is claimed cancels it before any call', async () => {
        const world = await seedWorld(db);
        const shutdown = new AbortController();
        shutdown.abort();
        const model = new FakeModel();
        const run = await execute(db, { world, model, deps: { shutdown: shutdown.signal } });
        expect(run.outcome).toMatchObject({ kind: 'cancelled', code: 'worker_shutdown' });
        expect(model.calls).toHaveLength(0);
      });
    });

    it('two workers racing for one run: exactly one executes it', async () => {
      const world = await seedWorld(db);
      const model = new FakeModel();
      const provider = new ScriptedProvider([model.step], { repeatLast: true });
      const a = harness(db);
      const b = harness(db);
      const runId = await requestRun(a, world, provider);
      const outcomes = await Promise.all([
        runAssessment(a.deps(provider), runId),
        runAssessment(b.deps(provider), runId),
      ]);
      expect(outcomes.map((o) => o.kind).sort()).toEqual(['not_claimed', 'succeeded']);
      expect(model.calls).toHaveLength(11); // one execution's worth of calls, not two
      const [run] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, runId));
      expect(run).toMatchObject({ state: 'succeeded', attemptCount: 1 });
    });
  },
);
