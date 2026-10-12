/*
 * M5 P6A — offline end-to-end through HTTP: the REAL API routes create a pending run, the REAL assessment loop (SKIP LOCKED claim,
 * lease, heartbeat, spending ledger, persistence) executes it with the OFFLINE replay provider, and the REAL API reads the result.
 * No model, no network, no credential: the replay fixture is recorded here from a hand-written scripted model and is synthetic.
 */
import {
  analysisRuns,
  assessmentRunCalls,
  AssessmentRunStore,
  preInterviewAssessments,
  type JudgeDatabase,
} from '../../packages/database/src/index.js';
import {
  computeRequestDigest,
  ReplayProvider,
  ScriptedProvider,
} from '../../packages/llm/src/index.js';
import { ApiErrorBody, ScoreReport } from '../../packages/schemas/src/index.js';
import { createLogger } from '../../packages/shared/src/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssessmentService } from '../../apps/api/src/assessments/service.js';
import { buildApp, SERVICE_NAME, type ApiApp } from '../../apps/api/src/app.js';
import { ProjectService } from '../../apps/api/src/projects/service.js';
import { bearer, fakeVerifier, TEST_TOKENS } from '../../apps/api/src/testing/harness.js';
import { corruptions } from '../../apps/worker/src/testing/corrupt.js';
import { createAssessmentLoop } from '../../apps/worker/src/assessment/loop.js';
import { harness, seedWorld, TEST_MODELS } from '../../apps/worker/src/testing/assessment-world.js';
import { FakeModel } from '../../apps/worker/src/testing/fake-model.js';
import {
  memoryLogger,
  testDatabaseTargets,
  type TestDatabase,
} from '../../apps/worker/src/testing/harness.js';
import { execute } from '../../apps/worker/src/testing/run.js';

const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
const KEY = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface Entry {
  requestDigest: string;
  stage: string;
  note: string;
  output: unknown;
  usage: { inputTokens: number; outputTokens: number };
}

describe.each(testDatabaseTargets())(
  'offline replay end to end through HTTP on %s',
  (_name, open) => {
    let testDb: TestDatabase;
    let db: JudgeDatabase;
    let app: ApiApp;
    let entries: Entry[];

    async function call(
      method: 'GET' | 'POST',
      url: string,
      key?: string,
      payload?: unknown,
      token: string = TEST_TOKENS.organizer,
    ) {
      const response = await app.inject({
        method,
        url,
        headers: { ...bearer(token), ...(key ? { 'idempotency-key': key } : {}) },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
    }

    /** Runs the worker loop over the offline replay provider until no work is left. */
    async function work(fixtureEntries: Entry[] = entries) {
      const replay = new ReplayProvider({
        fixtures: { version: 'replay-fixtures/v1', synthetic: true, entries: fixtureEntries },
      });
      const h = harness(db);
      const { shutdown: _shutdown, ...deps } = h.deps(replay);
      const outcomes: unknown[] = [];
      const loop = createAssessmentLoop({
        db,
        runs: h.runs,
        logger: memoryLogger().logger,
        concurrency: 1,
        pollIntervalMs: 50,
        onOutcome: (_id, outcome) => void outcomes.push(outcome),
        pipeline: deps,
      });
      await loop.drain();
      return outcomes;
    }

    beforeAll(async () => {
      testDb = await open();
      db = testDb.db;
      // 1. record the hand-written model's answers under the digests the REPLAY provider will compute
      entries = [];
      const recorderModel = new FakeModel();
      await execute(db, {
        provider: new ScriptedProvider(
          [
            (request) => {
              const result = recorderModel.step(request);
              if (result.ok) {
                entries.push({
                  requestDigest: computeRequestDigest({ ...request, provider: 'replay' }),
                  stage: request.stage,
                  note: 'synthetic: hand-authored by the test, not produced by any model',
                  output: result.json,
                  usage: {
                    inputTokens: result.usage.inputTokens,
                    outputTokens: result.usage.outputTokens,
                  },
                });
              }
              return result;
            },
          ],
          { repeatLast: true },
        ),
      });
      // 2. the API, configured for the offline replay provider (the same models the fixture was recorded for)
      app = buildApp({
        logger,
        db,
        verifier: fakeVerifier(),
        projects: new ProjectService({ db }),
        assessments: new AssessmentService({
          db,
          offline: { provider: { id: 'replay', mode: 'replay' }, models: TEST_MODELS },
        }),
      });
    });
    afterAll(async () => {
      await app.close();
      await testDb.close();
    });

    it('POST creates a pending run; the worker executes it; GET shows a verified, labelled, replay-demonstration assessment', async () => {
      const world = await seedWorld(db);
      const base = `/projects/${world.project.id}`;
      const post = await call('POST', `${base}/assessments`, KEY(1), { mode: 'assess' });
      expect(post.status).toBe(202);
      const runId = post.body['runId'] as string;
      // nothing ran inside the request
      expect(
        (await db.select().from(assessmentRunCalls)).filter((c) => c.runId === runId),
      ).toHaveLength(0);
      expect((await call('GET', `${base}/assessment-runs/${runId}`)).body).toMatchObject({
        state: 'pending',
      });

      const outcomes = await work();
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ kind: 'succeeded' });

      const run = await call('GET', `${base}/assessment-runs/${runId}`);
      expect(run.body).toMatchObject({
        state: 'succeeded',
        replayDemonstration: true,
        providerMode: 'replay',
        failureCode: null,
      });
      expect((run.body['usage'] as { attemptsStarted: number }).attemptsStarted).toBe(11);
      const assessmentId = run.body['assessmentId'] as string;

      const list = await call('GET', `${base}/assessments`);
      const listed = list.body['assessments'] as {
        id: string;
        versionNumber: number;
        replayDemonstration: boolean;
        verified: boolean;
        overall: { state: string; score10: number | null };
      }[];
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id: assessmentId,
        versionNumber: 1,
        replayDemonstration: true,
        verified: true,
      });
      expect(listed[0]?.overall).toMatchObject({ state: 'scored', score10: 7 });
      expect(list.body['activeRun']).toBeNull();

      const detail = await call('GET', `${base}/assessments/${assessmentId}`);
      expect(detail.status).toBe(200);
      const d = detail.body;
      expect(d).toMatchObject({
        verified: true,
        verificationFailure: null,
        replayDemonstration: true,
        target: 'overall',
      });
      expect(d['notices'] as Record<string, unknown>).toMatchObject({
        semanticRelevance: 'not_verified',
        storedText: 'not_hash_covered',
        target: 'overall_rubric_only',
      });
      expect((d['notices'] as { replay: string }).replay).toMatch(/REPLAY DEMONSTRATION/);
      const report = ScoreReport.parse(d['report']);
      expect(report.notices.semanticRelevance).toBe('not_verified');
      const judgments = d['judgments'] as {
        dimensionId: string;
        score: number | null;
        outcomeKind: string;
        dispositionAttribution: string;
        insufficiencyReason: string | null;
        citations: { evidence: { text: string; verificationLevel: string } | null }[];
      }[];
      expect(judgments).toHaveLength(2);
      for (const j of judgments) {
        expect(j.outcomeKind).toBe('scored');
        expect(j.dispositionAttribution).toBe('scored');
        expect(j.insufficiencyReason).toBeNull();
        expect(j.score).toBe(7);
        expect(j.citations.length).toBeGreaterThan(0);
        for (const c of j.citations) expect(c.evidence?.text.length).toBeGreaterThan(0);
      }
      expect(d['pipeline']).toMatchObject({ provider: { id: 'replay', mode: 'replay' } });

      // replays: same key after success; a new key for the same inputs; both spend nothing
      const before = (await db.select().from(assessmentRunCalls)).length;
      const again = await call('POST', `${base}/assessments`, KEY(1), { mode: 'assess' });
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({
        result: 'assessment_ready',
        assessmentId,
        replayed: true,
      });
      const equal = await call('POST', `${base}/assessments`, KEY(2), { mode: 'assess' });
      expect(equal.status).toBe(200);
      expect(equal.body).toMatchObject({ result: 'already_assessed', assessmentId });
      expect((await db.select().from(assessmentRunCalls)).length).toBe(before);

      // explicit reassessment: a NEW immutable version beside the first, newest first, the extraction reused
      const re = await call('POST', `${base}/assessments`, KEY(3), { mode: 'reassess' });
      expect(re.status).toBe(202);
      expect(await work()).toHaveLength(1);
      const after = (await call('GET', `${base}/assessments`)).body['assessments'] as {
        id: string;
        versionNumber: number;
      }[];
      expect(after.map((a) => a.versionNumber)).toEqual([2, 1]);
      expect(after[1]?.id).toBe(assessmentId);

      // isolation: another project's route can not reach this assessment or run
      const other = await seedWorld(db);
      expect(
        (await call('GET', `/projects/${other.project.id}/assessments/${assessmentId}`)).status,
      ).toBe(404);
      expect(
        (await call('GET', `/projects/${other.project.id}/assessment-runs/${runId}`)).status,
      ).toBe(404);
      const crossKey = await call('POST', `/projects/${other.project.id}/assessments`, KEY(1), {
        mode: 'assess',
      });
      expect(crossKey.status).toBe(422);
      expect(ApiErrorBody.parse(crossKey.body).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('a run that FAILS is shown as failed with its recorded code, never as an assessment; a same-key retry replays the failure', async () => {
      const world = await seedWorld(db);
      const base = `/projects/${world.project.id}`;
      const post = await call('POST', `${base}/assessments`, KEY(10), { mode: 'assess' });
      expect(post.status).toBe(202);
      const outcomes = await work([]); // an empty fixture: the first model call is a replay miss
      expect(outcomes[0]).toMatchObject({ kind: 'failed', category: 'provider_error' });
      const runId = post.body['runId'] as string;
      const run = await call('GET', `${base}/assessment-runs/${runId}`);
      expect(run.body).toMatchObject({
        state: 'failed',
        failureCategory: 'provider_error',
        failureCode: 'replay_miss',
        assessmentId: null,
      });
      const list = (await call('GET', `${base}/assessments`)).body;
      expect(list['assessments']).toEqual([]);
      expect(list['latestRun']).toMatchObject({ state: 'failed' });
      expect(
        (await db.select().from(preInterviewAssessments)).filter(
          (a) => a.projectId === world.project.id,
        ),
      ).toHaveLength(0);
      const retry = await call('POST', `${base}/assessments`, KEY(10), { mode: 'assess' });
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({ result: 'run_failed', state: 'failed', replayed: true });
      const fresh = await call('POST', `${base}/assessments`, KEY(11), { mode: 'assess' });
      expect(fresh.status).toBe(202);
      expect(await work()).toHaveLength(1);
      expect((await call('GET', `${base}/assessments`)).body['assessments']).toHaveLength(1);
    });

    it.each([
      ['a corrupted JSONB mirror', 'reportMirror', 'jsonb_mirror'],
      [
        'judgment scores that disagree with the report',
        'judgmentScores',
        'judgment_mismatch_score',
      ],
    ] as const)(
      'over HTTP, an assessment with %s is withheld: verified=false, no report, no judgments, no number, no text',
      async (_label, corruption, failure) => {
        const world = await seedWorld(db);
        const base = `/projects/${world.project.id}`;
        expect(
          (
            await call(
              'POST',
              `${base}/assessments`,
              KEY(corruption === 'reportMirror' ? 40 : 41),
              { mode: 'assess' },
            )
          ).status,
        ).toBe(202);
        await work();
        const list = (await call('GET', `${base}/assessments`)).body['assessments'] as {
          id: string;
        }[];
        const id = list[0]?.id ?? '';
        const before = await call('GET', `${base}/assessments/${id}`);
        expect(before.body).toMatchObject({ verified: true });
        const texts = (before.body['judgments'] as { rationale: string | null }[]).flatMap((j) =>
          j.rationale && j.rationale.length >= 12 ? [j.rationale] : [],
        );
        expect(texts.length).toBeGreaterThan(0);

        await corruptions[corruption](db, id);

        const detail = await call('GET', `${base}/assessments/${id}`);
        expect(detail.status).toBe(200);
        expect(detail.body).toMatchObject({
          verified: false,
          verificationFailure: failure,
          report: null,
          judgments: [],
          limitations: [],
        });
        const serialized = JSON.stringify(detail.body);
        for (const text of texts) expect(serialized).not.toContain(text);
        for (const key of ['"score"', '"score10"', '"scoreOnScale"', '"rationale"']) {
          expect(serialized).not.toContain(key);
        }
        // the run view of a withheld assessment carries state and totals only: no score, no text
        const runView = await call(
          'GET',
          `${base}/assessment-runs/${before.body['runId'] as string}`,
        );
        expect(runView.status).toBe(200);
        expect(runView.body).toMatchObject({ state: 'succeeded', assessmentId: id });
        const runText = JSON.stringify(runView.body);
        for (const key of ['"score"', '"score10"', '"scoreOnScale"', '"rationale"']) {
          expect(runText).not.toContain(key);
        }
        const listed = (await call('GET', `${base}/assessments`)).body['assessments'] as {
          id: string;
          verified: boolean;
          overall: unknown;
        }[];
        expect(listed.find((item) => item.id === id)).toMatchObject({
          verified: false,
          overall: null,
        });
      },
    );

    it('an abandoned pending run is cancelled by the pending-expiry policy and shows as cancelled, not as an assessment', async () => {
      const world = await seedWorld(db);
      const base = `/projects/${world.project.id}`;
      const post = await call('POST', `${base}/assessments`, KEY(20), { mode: 'assess' });
      const runId = post.body['runId'] as string;
      // the expiry operation the loop uses, with a cutoff in the future
      expect(
        await new AssessmentRunStore({ db }).expirePendingRun(
          runId,
          new Date(Date.now() + 3_600_000),
        ),
      ).toBe(true);
      const run = await call('GET', `${base}/assessment-runs/${runId}`);
      expect(run.body).toMatchObject({
        state: 'cancelled',
        failureCode: 'pending_expired',
        assessmentId: null,
      });
      const row = (await db.select().from(analysisRuns)).find((r) => r.id === runId);
      expect(row?.state).toBe('cancelled');
      const retry = await call('POST', `${base}/assessments`, KEY(20), { mode: 'assess' });
      expect(retry.body).toMatchObject({ result: 'run_failed', state: 'cancelled' });
    });
  },
);
