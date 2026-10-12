import {
  analysisRuns,
  assessmentRunCalls,
  AssessmentRunStore,
  assessmentRunInputs,
} from '@judge-copilot/database';
import { ApiErrorBody, ProjectRecord } from '@judge-copilot/schemas';
import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import { buildPipelineConfig } from '@judge-copilot/prompts';
import { createLogger } from '@judge-copilot/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, SERVICE_NAME, type ApiApp } from '../app.js';
import type { EventContextService } from '../event-context/service.js';
import { ProjectService } from '../projects/service.js';
import { seedCapturedSnapshot } from '../testing/graph-fixtures.js';
import {
  bearer,
  fakeVerifier,
  loadFixtures,
  lockedEventFromRecording,
  replayService,
  requireValue,
  TEST_TOKENS,
  testDatabaseTargets,
  type TestDatabase,
} from '../testing/harness.js';
import { openOfflineGate, type OfflineAssessmentRuntime } from './runtime-gate.js';
import { AssessmentService } from './service.js';

const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
const MISSING = '5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e';
const KEY = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const RUNTIME: OfflineAssessmentRuntime = {
  provider: { id: 'replay', mode: 'replay' },
  models: {
    extraction: 'claude-haiku-5-5',
    assessment: 'claude-sonnet-5-5',
    critic: 'claude-sonnet-5-5',
  },
};

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

describe.each(testDatabaseTargets())('M5 P6A assessment HTTP API on %s', (_name, open) => {
  let testDb: TestDatabase;
  let eventContext: EventContextService;
  let app: ApiApp;
  let unconfigured: ApiApp;
  let projectId: string;
  let otherProjectId: string;
  let emptyProjectId: string;

  async function call(
    method: Method,
    url: string,
    options: {
      payload?: unknown;
      token?: string | null;
      key?: string | null;
      on?: ApiApp;
    } = {},
  ) {
    const token = options.token === undefined ? TEST_TOKENS.organizer : options.token;
    const response = await (options.on ?? app).inject({
      method,
      url,
      headers: {
        ...(token ? bearer(token) : {}),
        ...(options.key ? { 'idempotency-key': options.key } : {}),
      },
      ...(options.payload === undefined ? {} : { payload: options.payload as object }),
    });
    return {
      status: response.statusCode,
      body: response.json<unknown>(),
      headers: response.headers,
    };
  }
  const code = (body: unknown) => ApiErrorBody.parse(body).error.code;

  async function createProject(name: string, captured: boolean) {
    const fixtures = await loadFixtures();
    const { eventId } = await lockedEventFromRecording(
      eventContext,
      requireValue(fixtures.get('fixture-e-multiple-tracks')),
    );
    const created = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/projects`,
      headers: bearer(TEST_TOKENS.organizer),
      payload: { name, trackKeys: [] },
    });
    expect(created.statusCode).toBe(201);
    const id = ProjectRecord.parse(created.json()).id;
    if (captured) {
      await seedCapturedSnapshot(testDb.db, id, 'devpost', [
        {
          key: 'submission.txt',
          kind: 'submission_text',
          mediaType: 'text/plain',
          text: 'A synthetic submission.',
        },
      ]);
    }
    return id;
  }

  beforeAll(async () => {
    testDb = await open();
    const fixtures = await loadFixtures();
    eventContext = replayService(testDb.db, fixtures.values());
    const common = {
      logger,
      db: testDb.db,
      verifier: fakeVerifier(),
      eventContext,
      projects: new ProjectService({ db: testDb.db }),
    };
    app = buildApp({
      ...common,
      assessments: new AssessmentService({ db: testDb.db, offline: RUNTIME }),
    });
    unconfigured = buildApp({
      ...common,
      assessments: new AssessmentService({ db: testDb.db, offline: null }),
    });
    projectId = await createProject('Synthetic Assessment Subject', true);
    otherProjectId = await createProject('Synthetic Other Subject', true);
    emptyProjectId = await createProject('Synthetic Uncaptured Subject', false);
  });
  afterAll(async () => {
    await app.close();
    await unconfigured.close();
    await testDb.close();
  });

  const LIST = (p: string) => `/projects/${p}/assessments`;
  const RUN = (p: string, r: string) => `/projects/${p}/assessment-runs/${r}`;
  const ONE = (p: string, a: string) => `/projects/${p}/assessments/${a}`;

  describe('authentication, authorization and methods', () => {
    it('rejects anonymous, malformed and unauthorized callers on every route (and answers before any validation)', async () => {
      const routes: [Method, string][] = [
        ['POST', LIST(projectId)],
        ['GET', LIST(projectId)],
        ['GET', ONE(projectId, MISSING)],
        ['GET', RUN(projectId, MISSING)],
      ];
      for (const [method, url] of routes) {
        const anonymous = await call(method, url, {
          token: null,
          payload: method === 'POST' ? { mode: 'assess' } : undefined,
        });
        expect(anonymous.status, `${method} ${url}`).toBe(401);
        expect(code(anonymous.body)).toBe('UNAUTHENTICATED');
        expect((await call(method, url, { token: 'not-a-real-credential' })).status).toBe(401);
        const noRole = await call(method, url, {
          token: TEST_TOKENS.noRole,
          key: KEY(1),
          payload: method === 'POST' ? { mode: 'assess' } : undefined,
        });
        expect(noRole.status, `${method} ${url}`).toBe(403);
        expect(code(noRole.body)).toBe('FORBIDDEN');
      }
    });

    it('lets organizers and judges read the same data, and lets both request an assessment', async () => {
      const organizer = await call('GET', LIST(projectId), { token: TEST_TOKENS.organizer });
      const judge = await call('GET', LIST(projectId), { token: TEST_TOKENS.judge });
      expect(organizer.status).toBe(200);
      expect(judge.body).toEqual(organizer.body);
      const asJudge = await call('POST', LIST(otherProjectId), {
        token: TEST_TOKENS.judge,
        key: KEY(2),
        payload: { mode: 'assess' },
      });
      expect(asJudge.status).toBe(202);
    });

    it('refuses every unsupported method explicitly (405), after authentication', async () => {
      const refusals: [Method, string][] = [
        ['PUT', LIST(projectId)],
        ['PATCH', LIST(projectId)],
        ['DELETE', LIST(projectId)],
        ['POST', ONE(projectId, MISSING)],
        ['PUT', ONE(projectId, MISSING)],
        ['PATCH', ONE(projectId, MISSING)],
        ['DELETE', ONE(projectId, MISSING)],
        ['POST', RUN(projectId, MISSING)],
        ['PUT', RUN(projectId, MISSING)],
        ['PATCH', RUN(projectId, MISSING)],
        ['DELETE', RUN(projectId, MISSING)],
      ];
      for (const [method, url] of refusals) {
        const response = await call(method, url, { payload: method === 'DELETE' ? undefined : {} });
        expect(response.status, `${method} ${url}`).toBe(405);
        expect(code(response.body)).toBe('ASSESSMENT_READ_ONLY');
        expect((await call(method, url, { token: null })).status).toBe(401);
      }
    });
  });

  describe('request validation', () => {
    it('requires a UUID Idempotency-Key and a strict body { mode }', async () => {
      for (const key of [null, 'not-a-uuid', '1234']) {
        const response = await call('POST', LIST(emptyProjectId), {
          key,
          payload: { mode: 'assess' },
        });
        expect(response.status).toBe(400);
        expect(code(response.body)).toBe('INVALID_REQUEST');
      }
      for (const payload of [
        {},
        { mode: 'rerun' },
        { mode: 'assess', extra: 1 },
        { mode: 'assess', limits: { maxCalls: 1 } },
        'assess',
        null,
      ]) {
        const response = await call('POST', LIST(emptyProjectId), { key: KEY(3), payload });
        // a non-JSON body is refused by the HTTP layer (415) before validation; every other malformed body is a 400
        expect([400, 415], JSON.stringify(payload)).toContain(response.status);
      }
      expect(
        (
          await call('POST', `/projects/not-a-uuid/assessments`, {
            key: KEY(3),
            payload: { mode: 'assess' },
          })
        ).status,
      ).toBe(400);
      expect((await call('GET', `/projects/${projectId}/assessments/not-a-uuid`)).status).toBe(400);
    });

    it('lets the client choose nothing else: no limit, model, provider or price table can be sent', async () => {
      const response = await call('POST', LIST(emptyProjectId), {
        key: KEY(4),
        payload: {
          mode: 'assess',
          pipelineConfig: { provider: { id: 'live', mode: 'live' } },
          priceTableId: 'x',
        },
      });
      expect(response.status).toBe(400);
    });
  });

  describe('the provider gate', () => {
    it('answers 503 ASSESSMENT_PROVIDER_NOT_CONFIGURED without touching anything, while reads keep working', async () => {
      const before = (await testDb.db.select().from(analysisRuns)).length;
      const response = await call('POST', LIST(projectId), {
        on: unconfigured,
        key: KEY(5),
        payload: { mode: 'assess' },
      });
      expect(response.status).toBe(503);
      expect(code(response.body)).toBe('ASSESSMENT_PROVIDER_NOT_CONFIGURED');
      expect((await testDb.db.select().from(analysisRuns)).length).toBe(before);
      const list = await call('GET', LIST(projectId), { on: unconfigured });
      expect(list.status).toBe(200);
      expect(list.body).toMatchObject({ launch: { available: false, providerMode: null } });
    });

    it('opens only for an explicitly configured replay provider that the runtime gate approves, with a valid synthetic fixture', async () => {
      const models = RUNTIME.models;
      expect(
        (await openOfflineGate({ provider: 'none', fixturePath: undefined, models })).runtime,
      ).toBeNull();
      expect(
        await openOfflineGate({ provider: 'replay', fixturePath: undefined, models }),
      ).toMatchObject({ runtime: null });
      const bad = await openOfflineGate({
        provider: 'replay',
        fixturePath: 'x.json',
        models,
        readFixture: () => Promise.resolve('{"not":"a fixture"}'),
      });
      expect(bad.runtime).toBeNull();
      const valid = JSON.stringify({ version: 'replay-fixtures/v1', synthetic: true, entries: [] });
      expect(
        (
          await openOfflineGate({
            provider: 'replay',
            fixturePath: 'x.json',
            models,
            readFixture: () => Promise.resolve(valid),
          })
        ).runtime,
      ).toEqual(RUNTIME);
      // an invented "not synthetic" fixture is refused
      const notSynthetic = JSON.stringify({
        version: 'replay-fixtures/v1',
        synthetic: false,
        entries: [],
      });
      expect(
        (
          await openOfflineGate({
            provider: 'replay',
            fixturePath: 'x.json',
            models,
            readFixture: () => Promise.resolve(notSynthetic),
          })
        ).runtime,
      ).toBeNull();
    });
  });

  describe('requests, idempotency and isolation', () => {
    it('creates ONE pending run with the shared, frozen configuration and starts no work', async () => {
      const response = await call('POST', LIST(projectId), {
        key: KEY(10),
        payload: { mode: 'assess' },
      });
      expect(response.status).toBe(202);
      const created = response.body as {
        result: string;
        runId: string;
        state: string;
        replayed: boolean;
      };
      expect(created).toMatchObject({ result: 'run_created', state: 'pending', replayed: false });
      const [run] = await testDb.db
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.id, created.runId));
      expect(run).toMatchObject({
        state: 'pending',
        runType: 'pre_interview_assessment',
        projectId,
      });
      expect(
        await testDb.db
          .select()
          .from(assessmentRunCalls)
          .where(eq(assessmentRunCalls.runId, created.runId)),
      ).toHaveLength(0);
      // the frozen configuration is byte-for-byte the shared builder's output (one identity for API and worker)
      const [inputs] = await testDb.db
        .select()
        .from(assessmentRunInputs)
        .where(eq(assessmentRunInputs.runId, created.runId));
      const expected = buildPipelineConfig({ provider: RUNTIME.provider, models: RUNTIME.models });
      expect(canonicalJson(inputs?.pipelineConfig)).toBe(canonicalJson(expected));
      expect(inputs?.pipelineConfigHash).toBe(sha256Hex(canonicalJson(expected)));
      expect(inputs?.targetKind).toBe('overall');
      // GET shows it pending with the local spending guard and the replay label
      const view = await call('GET', RUN(projectId, created.runId));
      expect(view.status).toBe(200);
      expect(view.body).toMatchObject({
        id: created.runId,
        state: 'pending',
        replayDemonstration: true,
        providerMode: 'replay',
        assessmentId: null,
        failureCode: null,
        mode: 'assess',
        guard: {
          priceTableId: 'prices/v1',
          notice: 'local_spending_guard_not_a_provider_billing_limit',
        },
        usage: { attemptsStarted: 0 },
      });
      const list = await call('GET', LIST(projectId));
      expect(list.body).toMatchObject({
        assessments: [],
        activeRun: { id: created.runId, state: 'pending' },
        latestRun: { id: created.runId },
      });
    });

    it('replays the same key while the run is active (202, same run), conflicts for a new key (409), and reuses a key only for the same request (422)', async () => {
      const same = await call('POST', LIST(projectId), {
        key: KEY(10),
        payload: { mode: 'assess' },
      });
      expect(same.status).toBe(202);
      expect(same.body).toMatchObject({ result: 'run_active', state: 'pending', replayed: true });
      const activeId = (same.body as { runId: string }).runId;
      const fresh = await call('POST', LIST(projectId), {
        key: KEY(11),
        payload: { mode: 'assess' },
      });
      expect(fresh.status).toBe(409);
      expect(code(fresh.body)).toBe('ASSESSMENT_RUN_ACTIVE');
      expect(fresh.body).toMatchObject({ error: { details: { runId: activeId } } });
      const other = await call('POST', LIST(projectId), {
        key: KEY(10),
        payload: { mode: 'reassess' },
      });
      expect(other.status).toBe(422);
      expect(code(other.body)).toBe('IDEMPOTENCY_KEY_REUSED');
      // the same key on ANOTHER project is a different request, never the first project's run
      const crossProject = await call('POST', LIST(otherProjectId), {
        key: KEY(10),
        payload: { mode: 'assess' },
      });
      expect(crossProject.status).toBe(422);
      expect(code(crossProject.body)).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('treats keys that differ only by case as the same key', async () => {
      const upper = await call('POST', LIST(projectId), {
        key: KEY(10).toUpperCase().replace(/-/g, '-'),
        payload: { mode: 'assess' },
      });
      expect(upper.status).toBe(202);
      expect(upper.body).toMatchObject({ result: 'run_active', replayed: true });
    });

    it('replays a recorded FAILURE for the same key (200, no new run) and starts a new run only for a new key', async () => {
      const [run] = await testDb.db
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.projectId, projectId));
      const store = new AssessmentRunStore({ db: testDb.db });
      const token = await store.claimRun(requireValue(run).id, 60_000);
      await store.finishRun({
        runId: requireValue(run).id,
        leaseToken: requireValue(token),
        state: 'failed',
        failureCategory: 'provider_error',
        failureCode: 'provider_unavailable',
        stageReached: 'claim_extraction',
      });
      const retry = await call('POST', LIST(projectId), {
        key: KEY(10),
        payload: { mode: 'assess' },
      });
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({
        result: 'run_failed',
        runId: requireValue(run).id,
        state: 'failed',
        failureCategory: 'provider_error',
        replayed: true,
      });
      const view = await call('GET', RUN(projectId, requireValue(run).id));
      expect(view.body).toMatchObject({
        state: 'failed',
        failureCategory: 'provider_error',
        failureCode: 'provider_unavailable',
        stageReached: 'claim_extraction',
        assessmentId: null,
      });
      const list = (await call('GET', LIST(projectId))).body as {
        assessments: unknown[];
        activeRun: unknown;
        latestRun: { state: string };
      };
      expect(list.assessments).toHaveLength(0); // a failed run is never shown as an assessment
      expect(list.activeRun).toBeNull();
      expect(list.latestRun.state).toBe('failed');
      const fresh = await call('POST', LIST(projectId), {
        key: KEY(12),
        payload: { mode: 'assess' },
      });
      expect(fresh.status).toBe(202);
      expect(fresh.body).toMatchObject({ result: 'run_created' });
    });

    it('reports NO_LOCKED_CONTEXT / NO_SOURCE_SNAPSHOTS / PROJECT_NOT_FOUND with stable codes and records nothing', async () => {
      const uncaptured = await call('POST', LIST(emptyProjectId), {
        key: KEY(20),
        payload: { mode: 'assess' },
      });
      expect(uncaptured.status).toBe(422);
      expect(code(uncaptured.body)).toBe('NO_SOURCE_SNAPSHOTS');
      const missing = await call('POST', LIST(MISSING), {
        key: KEY(21),
        payload: { mode: 'assess' },
      });
      expect(missing.status).toBe(404);
      expect(code(missing.body)).toBe('PROJECT_NOT_FOUND');
      expect(code((await call('GET', LIST(MISSING))).body)).toBe('PROJECT_NOT_FOUND');
    });

    it('answers a run or assessment of ANOTHER project exactly like a nonexistent one (404, identical bodies)', async () => {
      const [otherRun] = await testDb.db
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.projectId, otherProjectId));
      const crossRun = await call('GET', RUN(projectId, requireValue(otherRun).id));
      const missingRun = await call('GET', RUN(projectId, MISSING));
      expect(crossRun.status).toBe(404);
      expect(crossRun.body).toEqual(missingRun.body);
      expect(code(crossRun.body)).toBe('ASSESSMENT_RUN_NOT_FOUND');
      const crossAssessment = await call('GET', ONE(projectId, requireValue(otherRun).id));
      const missingAssessment = await call('GET', ONE(projectId, MISSING));
      expect(crossAssessment.status).toBe(404);
      expect(crossAssessment.body).toEqual(missingAssessment.body);
      expect(code(crossAssessment.body)).toBe('ASSESSMENT_NOT_FOUND');
      // a capture run id is not an assessment run either
      expect(requireValue(otherRun).runType).toBe('pre_interview_assessment');
    });
  });
});
