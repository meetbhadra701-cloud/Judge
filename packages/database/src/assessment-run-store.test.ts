import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AssessmentRunError } from './assessment-run-store.js';
import {
  analysisRuns,
  assessmentRequests,
  assessmentRunBudget,
  assessmentRunInputs,
  assessmentRunInputSnapshots,
  assessmentRunOutcomes,
  type JudgeDatabase,
} from './index.js';
import {
  createdRunId,
  freshKey,
  newRunStore,
  requestInput,
} from './testing/assessment-fixtures.js';
import {
  declareTrack,
  seedAssessmentWorld,
  seedLockedContext,
  type AssessmentWorld,
} from './testing/assessment-world.js';
import {
  expectPgError,
  rows,
  SQLSTATE,
  testDatabaseTargets,
  type TestDatabase,
} from './testing/databases.js';
import { seedSnapshot, sha256 } from './testing/graph-world.js';

const { CHECK_VIOLATION, UNIQUE_VIOLATION, RESTRICT_VIOLATION } = SQLSTATE;

describe.each(testDatabaseTargets())(
  'M5 P4 requests, pins and run lifecycle on %s',
  (_name, open) => {
    let testDb: TestDatabase;
    let db: JudgeDatabase;
    let w: AssessmentWorld;

    beforeAll(async () => {
      testDb = await open();
      db = testDb.db;
    });
    afterAll(async () => {
      await testDb.close();
    });
    beforeEach(async () => {
      w = await seedAssessmentWorld(db, {
        trackKeys: ['health', 'robotics'],
        declare: ['health'],
        rules: [{ statement: 'Every project must be original work.', certainty: 'explicit' }],
      });
    });

    const countRows = async (table: string, where = 'true') =>
      Number(
        (
          await rows<{ n: number }>(
            db,
            sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`),
          )
        )[0]?.n,
      );

    it('creates the run, request, pins and budget limits together (S0)', async () => {
      const store = newRunStore(db);
      const input = requestInput(w, { target: { kind: 'track', trackKey: 'health' } });
      const result = await store.requestAssessment(input);
      const runId = createdRunId(result);
      const run = await store.getRun(runId);
      expect(run).toMatchObject({
        state: 'pending',
        projectId: w.project.id,
        contextVersionId: w.context.versionId,
      });
      const [pins] = await db
        .select()
        .from(assessmentRunInputs)
        .where(eq(assessmentRunInputs.runId, runId));
      expect(pins).toMatchObject({
        lockedContentHash: w.context.hash,
        declaredTrackKeys: ['health'],
        targetKind: 'track',
        targetTrackKey: 'health',
      });
      const snapshotPins = await db
        .select()
        .from(assessmentRunInputSnapshots)
        .where(eq(assessmentRunInputSnapshots.runId, runId));
      expect(snapshotPins.map((p) => p.snapshotId).sort()).toEqual(
        [w.snapshots.devpost.snapshot.id, w.snapshots.github.snapshot.id].sort(),
      );
      const [budget] = await db
        .select()
        .from(assessmentRunBudget)
        .where(eq(assessmentRunBudget.runId, runId));
      expect(budget?.maxCalls).toBe(input.limits.maxCalls);
      expect(budget?.maxCostNanoUsd).toBe(input.limits.maxCostNanoUsd);
    });

    describe('the §8.6 idempotency matrix', () => {
      it('a retry with the same key while the run is active returns the SAME run and creates nothing', async () => {
        const store = newRunStore(db);
        const input = requestInput(w);
        const first = await store.requestAssessment(input);
        const runs = await countRows('analysis_runs', `project_id = '${w.project.id}'`);
        const again = await store.requestAssessment(input);
        expect(again).toMatchObject({
          kind: 'run_active',
          runId: createdRunId(first),
          replayed: true,
        });
        expect(await countRows('analysis_runs', `project_id = '${w.project.id}'`)).toBe(runs);
      });

      it('the same key with a different body is key_reused; nothing is created', async () => {
        const store = newRunStore(db);
        const input = requestInput(w);
        await store.requestAssessment(input);
        const other = await store.requestAssessment({
          ...input,
          requestHash: sha256('another body'),
        });
        expect(other.kind).toBe('key_reused');
        const modeChanged = await store.requestAssessment({ ...input, mode: 'reassess' });
        expect(modeChanged.kind).toBe('key_reused');
      });

      it('a new key while another run is active is a conflict (409) and records nothing', async () => {
        const store = newRunStore(db);
        const first = await store.requestAssessment(requestInput(w));
        const key = freshKey();
        const conflict = await store.requestAssessment(requestInput(w, { idempotencyKey: key }));
        expect(conflict).toEqual({ kind: 'run_active_conflict', runId: createdRunId(first) });
        expect(await store.getRequest(w.actor.id, key)).toBeNull();
      });

      it('a retry after FAILURE returns the recorded outcome and never starts another run', async () => {
        const store = newRunStore(db);
        const input = requestInput(w);
        const runId = createdRunId(await store.requestAssessment(input));
        const lease = await store.claimRun(runId, 60_000);
        expect(lease).not.toBeNull();
        await store.finishRun({
          runId,
          state: 'failed',
          failureCategory: 'provider_error',
          failureCode: 'provider_unavailable',
          stageReached: 'claim_extraction',
          providerMode: 'scripted',
        });
        const runsBefore = await countRows('analysis_runs', `project_id = '${w.project.id}'`);
        const retry = await store.requestAssessment(input);
        expect(retry).toMatchObject({
          kind: 'run_failed',
          runId,
          state: 'failed',
          failureCategory: 'provider_error',
          replayed: true,
        });
        expect(await countRows('analysis_runs', `project_id = '${w.project.id}'`)).toBe(runsBefore);
        // an explicit new key (the UI's "Run again") is a new run
        const fresh = await store.requestAssessment(requestInput(w));
        expect(fresh.kind).toBe('run_created');
      });

      it('no locked context, no captured sources and a declared track the pinned version lacks all fail closed', async () => {
        const store = newRunStore(db);
        const emptyEvent = await seedAssessmentWorld(db);
        // delete nothing: build a project with no snapshots on a fresh event
        const { seedProject } = await import('./testing/graph-world.js');
        const bare = await seedProject(db, emptyEvent.event.id, 'No sources');
        const noSources = await store.requestAssessment({
          ...requestInput(emptyEvent),
          projectId: bare.id,
        });
        expect(noSources.kind).toBe('no_source_snapshots');
        // a new locked version that no longer defines the declared track 'robotics'
        await declareTrack(
          db,
          w.project.id,
          w.event.id,
          w.context.versionId,
          'robotics',
          w.actor.id,
        );
        await seedLockedContext(db, w.event.id, { trackKeys: ['health'] });
        const missing = await store.requestAssessment(requestInput(w));
        expect(missing).toEqual({ kind: 'track_not_in_context', trackKey: 'robotics' });
      });

      it('re-captures after pinning do not change what the run is about (invariant 17)', async () => {
        const store = newRunStore(db);
        const runId = createdRunId(await store.requestAssessment(requestInput(w)));
        const before = await db
          .select()
          .from(assessmentRunInputSnapshots)
          .where(eq(assessmentRunInputSnapshots.runId, runId));
        await seedSnapshot(db, w.project, 'github', 'captured', [
          {
            key: 'files/README.md',
            kind: 'file',
            mediaType: 'text/markdown',
            text: 'A newer capture.',
          },
        ]);
        const after = await db
          .select()
          .from(assessmentRunInputSnapshots)
          .where(eq(assessmentRunInputSnapshots.runId, runId));
        expect(after.map((p) => p.snapshotId).sort()).toEqual(
          before.map((p) => p.snapshotId).sort(),
        );
      });
    });

    describe('lease, recovery and the run state machine', () => {
      it('claims a pending run once; a stale or wrong lease cannot finish or extend it', async () => {
        const store = newRunStore(db);
        const runId = createdRunId(await store.requestAssessment(requestInput(w)));
        const lease = await store.claimRun(runId, 60_000);
        expect(lease).toMatch(/^[0-9a-f-]{36}$/);
        expect(await store.claimRun(runId, 60_000)).toBeNull();
        expect(await store.heartbeat(runId, lease ?? '', 60_000)).toBe(true);
        expect(await store.heartbeat(runId, '5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e', 60_000)).toBe(
          false,
        );
        await expect(
          store.finishRun({
            runId,
            leaseToken: '5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e',
            state: 'failed',
            failureCode: 'x',
          }),
        ).rejects.toMatchObject({ code: 'lease_mismatch' });
      });

      it('a crashed worker: the expired lease fails the run, in-flight calls become unknown and nothing is re-run', async () => {
        const store = newRunStore(db);
        const runId = createdRunId(await store.requestAssessment(requestInput(w)));
        await store.claimRun(runId, 1_000);
        const { DatabaseRunBudget } = await import('./run-budget-store.js');
        const budget = new DatabaseRunBudget({
          db,
          runId,
          measure: () => null,
        });
        const reserved = await budget.reserve({
          stage: 'claim_extraction',
          model: 'claude-haiku-5-5',
          requestDigest: sha256('d1'),
          bounds: { inputTokens: 100, outputTokens: 50, costNanoUsd: 5_000 },
        });
        expect(reserved.ok).toBe(true);
        // five seconds later the one-second lease has long expired
        const later = new Date(Date.now() + 5_000);
        expect(await store.recoverExpiredRuns(later)).toEqual([runId]);
        const run = await store.getRun(runId);
        expect(run).toMatchObject({ state: 'failed', failureCategory: 'internal_error' });
        const [outcome] = await db
          .select()
          .from(assessmentRunOutcomes)
          .where(eq(assessmentRunOutcomes.runId, runId));
        expect(outcome).toMatchObject({
          outcome: 'failed',
          failureCode: 'worker_lease_expired',
          unknownCalls: 1,
          attemptsStarted: 1,
          costNanoUsd: 5_000,
        });
        const entries = await budget.entries();
        expect(entries[0]).toMatchObject({ state: 'unknown', usageBasis: 'unknown_reserved' });
        // a second recovery finds nothing, and the lease holder can no longer finish it
        expect(await store.recoverExpiredRuns(later)).toEqual([]);
        await expect(
          store.finishRun({ runId, state: 'failed', failureCode: 'x' }),
        ).rejects.toBeInstanceOf(AssessmentRunError);
      });

      it('the database state machine rejects impossible transitions (direct SQL)', async () => {
        const store = newRunStore(db);
        const runId = createdRunId(await store.requestAssessment(requestInput(w)));
        await expectPgError(
          db.execute(
            sql`UPDATE analysis_runs SET state = 'succeeded', finished_at = now(), started_at = now() WHERE id = ${runId}`,
          ),
          RESTRICT_VIOLATION,
          CHECK_VIOLATION,
        );
        await store.claimRun(runId, 60_000);
        await expectPgError(
          db.execute(
            sql`UPDATE analysis_runs SET state = 'pending', started_at = NULL, lease_token = NULL, lease_expires_at = NULL WHERE id = ${runId}`,
          ),
          RESTRICT_VIOLATION,
          CHECK_VIOLATION,
        );
      });

      it('a run cannot end while a call is still reserved, and a terminal run needs its outcome row (deferred)', async () => {
        const store = newRunStore(db);
        const runId = createdRunId(await store.requestAssessment(requestInput(w)));
        await store.claimRun(runId, 60_000);
        const { DatabaseRunBudget } = await import('./run-budget-store.js');
        const budget = new DatabaseRunBudget({ db, runId, measure: () => null });
        await budget.reserve({
          stage: 'critic',
          model: 'm',
          requestDigest: sha256('r'),
          bounds: { inputTokens: 1, outputTokens: 1, costNanoUsd: 1 },
        });
        await expectPgError(
          db.execute(
            sql`UPDATE analysis_runs SET state = 'failed', failure_category = 'internal_error', finished_at = now() WHERE id = ${runId}`,
          ),
          CHECK_VIOLATION,
        );
        await budget.reapInFlight();
        // terminal state without an outcome row fails at COMMIT
        await expectPgError(
          db.transaction(async (tx) => {
            await tx.execute(
              sql`UPDATE analysis_runs SET state = 'failed', failure_category = 'internal_error', finished_at = now() WHERE id = ${runId}`,
            );
          }),
          CHECK_VIOLATION,
        );
        expect((await store.getRun(runId))?.state).toBe('running');
      });

      it('at most one active assessment run per project (partial unique index) and pins cannot be edited', async () => {
        const store = newRunStore(db);
        const runId = createdRunId(await store.requestAssessment(requestInput(w)));
        await expectPgError(
          db.insert(analysisRuns).values({
            runType: 'pre_interview_assessment',
            state: 'pending',
            eventId: w.event.id,
            projectId: w.project.id,
            contextVersionId: w.context.versionId,
            startedAt: null,
          }),
          UNIQUE_VIOLATION,
        );
        await expectPgError(
          db
            .update(assessmentRunInputs)
            .set({ lockedContentHash: sha256('x') })
            .where(eq(assessmentRunInputs.runId, runId)),
          RESTRICT_VIOLATION,
        );
        await expectPgError(
          db.delete(assessmentRequests).where(eq(assessmentRequests.runId, runId)),
          RESTRICT_VIOLATION,
        );
      });

      it('a run row without its pinned inputs and budget cannot be committed', async () => {
        await expectPgError(
          db.insert(analysisRuns).values({
            runType: 'pre_interview_assessment',
            state: 'pending',
            eventId: w.event.id,
            projectId: w.project.id,
            contextVersionId: w.context.versionId,
            startedAt: null,
          }),
          CHECK_VIOLATION,
        );
      });
    });
  },
);
