import { ApiErrorBody } from '../../packages/schemas/src/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  analysisRuns,
  assessmentRequests,
  projects,
  sourceSnapshots,
  type JudgeDatabase,
} from '../../packages/database/src/index.js';
import { createLogger } from '../../packages/shared/src/index.js';
import { AssessmentService } from '../../apps/api/src/assessments/service.js';
import { buildApp, SERVICE_NAME, type ApiApp } from '../../apps/api/src/app.js';
import type { EventContextService } from '../../apps/api/src/event-context/service.js';
import { ProjectService } from '../../apps/api/src/projects/service.js';
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
} from '../../apps/api/src/testing/harness.js';
import { captureSetup } from '../../apps/worker/src/testing/harness.js';
import { describeCapture } from '../../apps/web/lib/capture-status.js';
import { runSubmission, type ApiFn } from '../../apps/web/lib/submission.js';

/*
 * P6B-alpha: the submission flow against the REAL API routes and the REAL capture worker (fixture network, no socket). Covers the happy
 * path, double submission, retries after a failed capture, source isolation between projects, hostile input and the guarantee that
 * submitting never touches an assessment route.
 */

const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
const GITHUB = 'https://github.com/synthetic/atlas';
const DEVPOST = 'https://devpost.com/software/synthetic-atlas';

describe.each(testDatabaseTargets())('project submission flow on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;
  let app: ApiApp;
  let eventContext: EventContextService;
  const calls: { method: string; path: string }[] = [];

  /** The web tier's API function, served by the real routes through `inject`. */
  const api: ApiFn = async (method, path, body) => {
    calls.push({ method, path });
    const response = await app.inject({
      method,
      url: path,
      headers: bearer(TEST_TOKENS.organizer),
      ...(body === undefined ? {} : { payload: body as object }),
    });
    const json: unknown = response.statusCode === 204 ? null : response.json<unknown>();
    if (response.statusCode < 300) return { ok: true, data: json as never };
    const parsed = ApiErrorBody.parse(json);
    return {
      ok: false,
      status: response.statusCode,
      code: parsed.error.code,
      message: parsed.error.message,
      issues: [],
    };
  };

  async function lockedEvent(): Promise<string> {
    const fixtures = await loadFixtures();
    const { eventId } = await lockedEventFromRecording(
      eventContext,
      requireValue(fixtures.get('fixture-e-multiple-tracks')),
    );
    return eventId;
  }

  beforeAll(async () => {
    testDb = await open();
    db = testDb.db;
    const fixtures = await loadFixtures();
    eventContext = replayService(db, fixtures.values());
    app = buildApp({
      logger,
      db,
      verifier: fakeVerifier(),
      eventContext,
      projects: new ProjectService({ db }),
      assessments: new AssessmentService({ db, offline: null }),
    });
  });
  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  const input = (overrides: Partial<{ github: string; devpost: string; name: string }> = {}) => ({
    github: GITHUB,
    devpost: DEVPOST,
    name: '',
    ...overrides,
  });

  async function detail(projectId: string) {
    const result = await api<{
      id: string;
      name: string;
      sources: {
        id: string;
        sourceType: string;
        url: string;
        latestSnapshot: {
          status: string;
          captureNumber: number;
          failureCategory: string | null;
          partialReasons: string[];
        } | null;
      }[];
    }>('GET', `/projects/${projectId}`);
    if (!result.ok) throw new Error(result.message);
    return result.data;
  }

  async function drainCaptures() {
    const setup = await captureSetup(db);
    return setup.loop.drain();
  }

  it('creates the project, declares both sources and requests both captures, and nothing else', async () => {
    const eventId = await lockedEvent();
    calls.length = 0;
    const outcome = await runSubmission(api, eventId, input());
    expect(outcome).toMatchObject({
      kind: 'started',
      created: true,
      capturesRequested: 2,
      capturesLeftAlone: 0,
    });
    if (outcome.kind !== 'started') return;
    const project = await detail(outcome.projectId);
    expect(project.name).toBe('synthetic/atlas'); // derived from the GitHub URL
    expect(project.sources.map((s) => [s.sourceType, s.url]).sort()).toEqual([
      ['devpost', DEVPOST],
      ['github', GITHUB],
    ]);
    expect(project.sources.every((s) => s.latestSnapshot?.status === 'pending')).toBe(true);
    // NEVER an assessment: no route of that kind was called and no assessment row or run exists
    expect(calls.some((call) => /assessment/.test(call.path))).toBe(false);
    expect(await db.select().from(assessmentRequests)).toHaveLength(0);
    const assessmentRuns = (await db.select().from(analysisRuns)).filter(
      (run) => run.runType === 'pre_interview_assessment',
    );
    expect(assessmentRuns).toHaveLength(0);
    // a capture is not an analysis: the only runs are capture runs
    const runs = (await db.select().from(analysisRuns)).filter(
      (run) => run.projectId === outcome.projectId,
    );
    expect(runs.every((run) => run.runType === 'project_source_capture')).toBe(true);
  });

  it('a double click (three concurrent identical submissions) yields ONE project, one declaration per source and one pending capture per source', async () => {
    const eventId = await lockedEvent();
    const outcomes = await Promise.all([
      runSubmission(api, eventId, input({ github: 'https://github.com/synthetic/double' })),
      runSubmission(api, eventId, input({ github: 'https://github.com/synthetic/double' })),
      runSubmission(api, eventId, input({ github: 'https://github.com/synthetic/double' })),
    ]);
    for (const outcome of outcomes) expect(outcome.kind).toBe('started');
    const ids = new Set(outcomes.map((o) => (o.kind === 'started' ? o.projectId : '')));
    expect(ids.size).toBe(1);
    const projectId = [...ids][0] ?? '';
    const project = await detail(projectId);
    expect(project.sources).toHaveLength(2);
    const snapshots = (await db.select().from(sourceSnapshots)).filter(
      (snapshot) => snapshot.projectId === projectId,
    );
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every((s) => s.status === 'pending')).toBe(true);
    const listed = await api<{ projects: { id: string }[] }>('GET', `/events/${eventId}/projects`);
    expect(listed.ok && listed.data.projects.filter((p) => p.id === projectId)).toHaveLength(1);
  });

  it('submitting again while captures are pending, and again after they succeed, requests nothing new', async () => {
    const eventId = await lockedEvent();
    const first = await runSubmission(api, eventId, input());
    if (first.kind !== 'started') throw new Error('not started');
    const whilePending = await runSubmission(api, eventId, input());
    expect(whilePending).toMatchObject({
      kind: 'started',
      created: false,
      capturesRequested: 0,
      capturesLeftAlone: 2,
    });
    expect(await drainCaptures()).toBeGreaterThanOrEqual(2);
    const captured = await detail(first.projectId);
    expect(captured.sources.map((s) => s.latestSnapshot?.status)).toEqual(['captured', 'captured']);
    const after = await runSubmission(api, eventId, input());
    expect(after).toMatchObject({
      kind: 'started',
      created: false,
      capturesRequested: 0,
      capturesLeftAlone: 2,
    });
    const snapshots = (await db.select().from(sourceSnapshots)).filter(
      (snapshot) => snapshot.projectId === first.projectId,
    );
    expect(snapshots).toHaveLength(2); // still one snapshot per source
    // captured, not analysed: the page-level view says so
    for (const source of captured.sources) {
      expect(describeCapture(source.latestSnapshot as never).detail).toMatch(/not an analysis/);
    }
  });

  it('a failed capture is reported per source, and a re-submit retries ONLY the failed source (a new attempt, the old one stays)', async () => {
    const eventId = await lockedEvent();
    const body = input({ github: 'https://github.com/synthetic/does-not-exist' });
    const first = await runSubmission(api, eventId, body);
    if (first.kind !== 'started') throw new Error('not started');
    await drainCaptures();
    const afterFirst = await detail(first.projectId);
    const gh = afterFirst.sources.find((s) => s.sourceType === 'github');
    const dp = afterFirst.sources.find((s) => s.sourceType === 'devpost');
    expect(gh?.latestSnapshot?.status).toMatch(/failed|rejected/);
    expect(dp?.latestSnapshot?.status).toBe('captured'); // the other source is unaffected
    const failedView = describeCapture(gh?.latestSnapshot as never);
    expect(failedView.retryable).toBe(true);
    expect(failedView.hasContent).toBe(false);
    expect(failedView.detail.length).toBeGreaterThan(10);

    const retry = await runSubmission(api, eventId, body);
    expect(retry).toMatchObject({
      kind: 'started',
      created: false,
      capturesRequested: 1,
      capturesLeftAlone: 1,
    });
    await drainCaptures();
    const afterRetry = await detail(first.projectId);
    expect(
      afterRetry.sources.find((s) => s.sourceType === 'github')?.latestSnapshot?.captureNumber,
    ).toBe(2);
    expect(
      afterRetry.sources.find((s) => s.sourceType === 'devpost')?.latestSnapshot?.captureNumber,
    ).toBe(1);
    const all = (await db.select().from(sourceSnapshots)).filter(
      (snapshot) => snapshot.projectId === first.projectId,
    );
    expect(all).toHaveLength(3); // history is kept
  });

  it('isolates projects: two submissions in one event do not share sources, snapshots or captures', async () => {
    const eventId = await lockedEvent();
    const a = await runSubmission(api, eventId, input());
    const b = await runSubmission(
      api,
      eventId,
      input({
        github: 'https://github.com/synthetic/injection',
        devpost: 'https://devpost.com/software/another-entry',
      }),
    );
    if (a.kind !== 'started' || b.kind !== 'started') throw new Error('not started');
    expect(a.projectId).not.toBe(b.projectId);
    const [pa, pb] = [await detail(a.projectId), await detail(b.projectId)];
    expect(pa.sources.map((s) => s.url).sort()).toEqual([DEVPOST, GITHUB].sort());
    expect(pb.sources.map((s) => s.url).sort()).toEqual(
      [
        'https://devpost.com/software/another-entry',
        'https://github.com/synthetic/injection',
      ].sort(),
    );
    const ids = new Set([...pa.sources, ...pb.sources].map((s) => s.id));
    expect(ids.size).toBe(4);
    const snaps = await db.select().from(sourceSnapshots);
    const forA = snaps.filter((s) => s.projectId === a.projectId);
    const forB = snaps.filter((s) => s.projectId === b.projectId);
    expect(forA).toHaveLength(2);
    expect(forB).toHaveLength(2);
    // re-submitting A does not touch B
    await runSubmission(api, eventId, input());
    expect(
      (await db.select().from(sourceSnapshots)).filter((s) => s.projectId === b.projectId),
    ).toHaveLength(2);
  });

  it('refuses to merge into a different project that already uses the derived name, and says so (nothing is changed)', async () => {
    const eventId = await lockedEvent();
    const first = await runSubmission(api, eventId, input());
    if (first.kind !== 'started') throw new Error('not started');
    const clash = await runSubmission(
      api,
      eventId,
      input({ devpost: 'https://devpost.com/software/someone-else' }),
    );
    expect(clash).toMatchObject({ kind: 'failed', field: 'name', projectId: first.projectId });
    expect((await detail(first.projectId)).sources).toHaveLength(2);
    // an explicit different name is a visible choice that works
    const named = await runSubmission(
      api,
      eventId,
      input({ devpost: 'https://devpost.com/software/someone-else', name: 'Atlas (second entry)' }),
    );
    expect(named).toMatchObject({ kind: 'started', created: true });
  });

  it('an event without a locked Event Context cannot receive a project, and nothing is created', async () => {
    const created = await api<{ id: string }>('POST', '/events', {
      name: 'Unlocked Hackathon',
      slug: `unlocked-${String(Date.now())}`,
    });
    if (!created.ok) throw new Error(created.message);
    const before = (await db.select().from(projects)).length;
    const outcome = await runSubmission(api, created.data.id, input());
    expect(outcome).toMatchObject({ kind: 'failed' });
    expect(outcome.kind === 'failed' && outcome.message).toMatch(/no locked Event Context/);
    expect((await db.select().from(projects)).length).toBe(before);
    const missing = await runSubmission(api, '5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e', input());
    expect(missing).toMatchObject({ kind: 'failed', message: 'This hackathon does not exist.' });
  });

  it.each([
    ['javascript scheme', { github: 'javascript:alert(1)' }, 'github'],
    ['credentials in the URL', { github: 'https://user:secret@github.com/a/b' }, 'github'],
    ['a deeper GitHub path', { github: 'https://github.com/synthetic/atlas/tree/main' }, 'github'],
    ['a look-alike host', { github: 'https://github.com.evil.example/synthetic/atlas' }, 'github'],
    ['a Devpost link in the GitHub field', { github: DEVPOST }, 'github'],
    ['a GitHub link in the Devpost field', { devpost: GITHUB }, 'devpost'],
    ['a private address', { devpost: 'http://127.0.0.1/software/x' }, 'devpost'],
    ['an enormous URL', { github: `https://github.com/${'a'.repeat(5000)}/b` }, 'github'],
    ['a unicode look-alike', { github: 'https://gıthub.com/synthetic/atlas' }, 'github'],
    ['empty fields', { github: '', devpost: '' }, 'github'],
  ])('rejects %s before any request is made', async (_label, overrides, field) => {
    const eventId = await lockedEvent();
    const before = (await db.select().from(projects)).length;
    calls.length = 0;
    const outcome = await runSubmission(api, eventId, input(overrides));
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind === 'invalid') {
      expect(outcome.errors[field as 'github' | 'devpost']?.length).toBeGreaterThan(10);
    }
    expect(calls).toEqual([]); // not even a read
    expect((await db.select().from(projects)).length).toBe(before);
  });

  it('the API itself still guards the same rules (a source the form would refuse is refused by the route)', async () => {
    const eventId = await lockedEvent();
    const project = await api<{ id: string }>('POST', `/events/${eventId}/projects`, {
      name: 'guard-check',
    });
    if (!project.ok) throw new Error(project.message);
    const refused = await api('POST', `/projects/${project.data.id}/sources`, {
      sourceType: 'github',
      url: 'https://github.com/a/b/tree/main',
    });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.code).toBe('INVALID_SOURCE_URL');
  });

  it('an unauthenticated web tier cannot submit: the failure is reported and nothing is created', async () => {
    const eventId = await lockedEvent();
    const before = (await db.select().from(projects)).length;
    const anonymous: ApiFn = async (method, path, body) => {
      const response = await app.inject({
        method,
        url: path,
        ...(body === undefined ? {} : { payload: body as object }),
      });
      const parsed = ApiErrorBody.parse(response.json());
      return {
        ok: false,
        status: response.statusCode,
        code: parsed.error.code,
        message: parsed.error.message,
        issues: [],
      };
    };
    const outcome = await runSubmission(anonymous, eventId, input());
    expect(outcome.kind).toBe('failed');
    expect((await db.select().from(projects)).length).toBe(before);
  });
});
