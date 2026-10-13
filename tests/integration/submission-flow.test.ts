import { randomUUID } from 'node:crypto';
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
import { runCaptureRetry } from '../../apps/web/lib/action-errors.js';
import { runSubmission, type ApiFn } from '../../apps/web/lib/submission.js';

/*
 * P6B-alpha/beta1: the web tier's submission flow against the REAL API routes and the REAL capture worker (fixture network, no socket).
 * Covers the happy path, double submission, lost responses, two-tab races, retries after a failed capture, source isolation between
 * projects, hostile input and the guarantee that submitting never touches an assessment route. The API contract itself is covered by
 * submission-intent.test.ts.
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
  const api: ApiFn = async (method, path, body, headers) => {
    calls.push({ method, path });
    const response = await app.inject({
      method,
      url: path,
      headers: { ...bearer(TEST_TOKENS.organizer), ...headers },
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
      details: parsed.error.details,
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
  /** Every call gets its own form key unless a test reuses one (the same form, pressed again). */
  const run = (
    eventId: string,
    overrides: Partial<{ github: string; devpost: string; name: string }> = {},
    key: string = randomUUID(),
  ) => runSubmission(api, eventId, input(overrides), key);

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

  async function snapshotsOf(projectId: string) {
    return (await db.select().from(sourceSnapshots)).filter(
      (snapshot) => snapshot.projectId === projectId,
    );
  }

  it('creates the project, declares both sources and requests both captures with ONE write call, and nothing else', async () => {
    const eventId = await lockedEvent();
    calls.length = 0;
    const outcome = await run(eventId);
    expect(outcome).toMatchObject({ kind: 'started', result: 'created' });
    if (outcome.kind !== 'started') return;
    // the only calls: read the event, then the single atomic submission
    expect(calls.map((call) => `${call.method} ${call.path.replace(eventId, ':event')}`)).toEqual([
      'GET /events/:event',
      'POST /events/:event/submissions',
    ]);
    const project = await detail(outcome.projectId);
    expect(project.name).toBe('synthetic/atlas'); // derived from the GitHub URL
    expect(outcome.projectName).toBe('synthetic/atlas');
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

  it('a double click (the same form sent three times at once) yields ONE project, one declaration per source and one pending capture per source', async () => {
    const eventId = await lockedEvent();
    const key = randomUUID();
    const github = 'https://github.com/synthetic/double';
    const outcomes = await Promise.all([
      run(eventId, { github }, key),
      run(eventId, { github }, key),
      run(eventId, { github }, key),
    ]);
    for (const outcome of outcomes) expect(outcome.kind).toBe('started');
    expect(outcomes.filter((o) => o.kind === 'started' && o.result === 'created')).toHaveLength(1);
    const ids = new Set(outcomes.map((o) => (o.kind === 'started' ? o.projectId : '')));
    expect(ids.size).toBe(1);
    const projectId = [...ids][0] ?? '';
    const project = await detail(projectId);
    expect(project.sources).toHaveLength(2);
    const snapshots = await snapshotsOf(projectId);
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every((s) => s.status === 'pending')).toBe(true);
    const listed = await api<{ projects: { id: string }[] }>('GET', `/events/${eventId}/projects`);
    expect(listed.ok && listed.data.projects.filter((p) => p.id === projectId)).toHaveLength(1);
  });

  it('submitting again while captures are pending, and again after they succeed, requests nothing new (same form or a reloaded one)', async () => {
    const eventId = await lockedEvent();
    const key = randomUUID();
    const first = await run(eventId, {}, key);
    if (first.kind !== 'started') throw new Error('not started');
    const sameForm = await run(eventId, {}, key);
    expect(sameForm).toMatchObject({
      kind: 'started',
      result: 'replayed',
      projectId: first.projectId,
    });
    const reloaded = await run(eventId);
    expect(reloaded).toMatchObject({
      kind: 'started',
      result: 'already_submitted',
      projectId: first.projectId,
    });
    expect(await drainCaptures()).toBeGreaterThanOrEqual(2);
    const captured = await detail(first.projectId);
    expect(captured.sources.map((s) => s.latestSnapshot?.status)).toEqual(['captured', 'captured']);
    const after = await run(eventId);
    expect(after).toMatchObject({ kind: 'started', result: 'already_submitted' });
    expect(await snapshotsOf(first.projectId)).toHaveLength(2); // still one snapshot per source
    // captured, not analysed: the page-level view says so
    for (const source of captured.sources) {
      expect(describeCapture(source.latestSnapshot as never).detail).toMatch(/not an analysis/);
    }
  });

  it('a failed capture is reported per source; the per-source retry adds a new attempt for ONLY that source and keeps the history', async () => {
    const eventId = await lockedEvent();
    const first = await run(eventId, { github: 'https://github.com/synthetic/does-not-exist' });
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

    // resubmitting the form does NOT request captures (it is not a retry button) ...
    const again = await run(eventId, { github: 'https://github.com/synthetic/does-not-exist' });
    expect(again).toMatchObject({ kind: 'started', result: 'already_submitted' });
    expect(await snapshotsOf(first.projectId)).toHaveLength(2);
    // ... the capture page's retry does, for that source only, and a second click while pending is the documented 409
    const retry = await api(
      'POST',
      `/projects/${first.projectId}/sources/${gh?.id ?? ''}/captures`,
    );
    expect(retry.ok).toBe(true);
    const duplicate = await api(
      'POST',
      `/projects/${first.projectId}/sources/${gh?.id ?? ''}/captures`,
    );
    expect(!duplicate.ok && duplicate.code).toBe('CAPTURE_ALREADY_PENDING');
    await drainCaptures();
    const afterRetry = await detail(first.projectId);
    expect(
      afterRetry.sources.find((s) => s.sourceType === 'github')?.latestSnapshot?.captureNumber,
    ).toBe(2);
    expect(
      afterRetry.sources.find((s) => s.sourceType === 'devpost')?.latestSnapshot?.captureNumber,
    ).toBe(1);
    expect(await snapshotsOf(first.projectId)).toHaveLength(3); // history is kept
  });

  it('R7-12: the capture retry treats an already-pending capture as success, against the real routes', async () => {
    const eventId = await lockedEvent();
    const first = await run(eventId);
    if (first.kind !== 'started') throw new Error('not started');
    const source = (await detail(first.projectId)).sources[0];
    const request = (path: string) => api('POST', path);
    // the capture requested by the submission is still pending: asking again must not fail, and must not queue a second one
    const again = await runCaptureRetry(request, first.projectId, source?.id ?? '');
    expect(again).toEqual({ kind: 'already_pending' });
    expect(await snapshotsOf(first.projectId)).toHaveLength(2);
    // after the worker finished (failed or captured), a retry is a new attempt; a second click while it waits is "already pending" again
    await drainCaptures();
    const retried = await runCaptureRetry(request, first.projectId, source?.id ?? '');
    expect(retried).toEqual({ kind: 'requested' });
    expect(await runCaptureRetry(request, first.projectId, source?.id ?? '')).toEqual({
      kind: 'already_pending',
    });
    expect(await snapshotsOf(first.projectId)).toHaveLength(3);
    // a source of another project is not found, and that is a real failure
    const other = await run(eventId, {
      github: 'https://github.com/synthetic/another',
      devpost: 'https://devpost.com/software/another',
    });
    if (other.kind !== 'started') throw new Error('not started');
    const foreign = await runCaptureRetry(request, other.projectId, source?.id ?? '');
    expect(foreign.kind).toBe('failed');
  });

  it('isolates projects: two submissions in one event do not share sources, snapshots or captures', async () => {
    const eventId = await lockedEvent();
    const a = await run(eventId);
    const b = await run(eventId, {
      github: 'https://github.com/synthetic/injection',
      devpost: 'https://devpost.com/software/another-entry',
    });
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
    expect(await snapshotsOf(a.projectId)).toHaveLength(2);
    expect(await snapshotsOf(b.projectId)).toHaveLength(2);
    // re-submitting A does not touch B
    await run(eventId);
    expect(await snapshotsOf(b.projectId)).toHaveLength(2);
  });

  it('never merges a second submission into an existing project: a shared link or a clashing name is refused and says why', async () => {
    const eventId = await lockedEvent();
    const first = await run(eventId);
    if (first.kind !== 'started') throw new Error('not started');
    // same repository, different Devpost page: a different submission, not an update of the first
    const clash = await run(eventId, { devpost: 'https://devpost.com/software/someone-else' });
    expect(clash).toMatchObject({ kind: 'failed', projectId: first.projectId });
    expect(clash.kind === 'failed' && clash.message).toMatch(
      /Nothing was saved and nothing was merged/,
    );
    const stored = await detail(first.projectId);
    expect(stored.sources.map((s) => s.url).sort()).toEqual([DEVPOST, GITHUB].sort());
    // a name that differs only by capital letters is the same label
    const sameLabel = await run(eventId, {
      github: 'https://github.com/synthetic/second',
      devpost: 'https://devpost.com/software/second',
      name: 'SYNTHETIC/ATLAS',
    });
    expect(sameLabel).toMatchObject({ kind: 'failed', field: 'name' });
    // two truly different links and an explicit different name work
    const named = await run(eventId, {
      github: 'https://github.com/synthetic/second',
      devpost: 'https://devpost.com/software/second',
      name: 'Atlas (second entry)',
    });
    expect(named).toMatchObject({ kind: 'started', result: 'created' });
    expect((await detail(first.projectId)).sources).toHaveLength(2);
  });

  it('R7-1 through the web tier: two tabs submitting the same repository with different Devpost pages end with ONE project holding ONE of them', async () => {
    const eventId = await lockedEvent();
    for (let round = 0; round < 6; round += 1) {
      const github = `https://github.com/synthetic/tabs-${String(round)}`;
      const [tabA, tabB] = await Promise.all([
        run(eventId, { github, devpost: `https://devpost.com/software/tabs-${String(round)}-a` }),
        run(eventId, { github, devpost: `https://devpost.com/software/tabs-${String(round)}-b` }),
      ]);
      const started = [tabA, tabB].filter((o) => o.kind === 'started');
      const failed = [tabA, tabB].filter((o) => o.kind === 'failed');
      expect([started.length, failed.length]).toEqual([1, 1]);
      const winner = started[0];
      const loser = failed[0];
      if (winner?.kind !== 'started' || loser?.kind !== 'failed') throw new Error('unreachable');
      expect(loser.projectId).toBe(winner.projectId); // the loser is pointed at the project that holds the link
      const stored = await detail(winner.projectId);
      expect(stored.sources.filter((s) => s.sourceType === 'devpost')).toHaveLength(1);
      expect(stored.sources.filter((s) => s.sourceType === 'github')).toHaveLength(1);
      const all = await api<{ projects: { id: string; name: string }[] }>(
        'GET',
        `/events/${eventId}/projects`,
      );
      expect(
        all.ok && all.data.projects.filter((p) => p.name === `synthetic/tabs-${String(round)}`),
      ).toHaveLength(1);
    }
  });

  it('a lost response before the project was created: the retry with the same form creates it exactly once', async () => {
    const eventId = await lockedEvent();
    const key = randomUUID();
    const dropRequest: ApiFn = (method, path, body, headers) =>
      method === 'POST'
        ? Promise.resolve({
            ok: false,
            status: 503,
            code: 'API_UNREACHABLE',
            message: 'not reachable',
            issues: [],
          })
        : api(method, path, body, headers);
    const lost = await runSubmission(dropRequest, eventId, input(), key);
    expect(lost).toMatchObject({ kind: 'failed', outcomeUnknown: true });
    expect(lost.kind === 'failed' && lost.message).toMatch(
      /Submitting the same form twice is safe/,
    );
    const none = await api<{ projects: unknown[] }>('GET', `/events/${eventId}/projects`);
    expect(none.ok && none.data.projects).toHaveLength(0);
    const retried = await run(eventId, {}, key);
    expect(retried).toMatchObject({ kind: 'started', result: 'created' });
    const after = await api<{ projects: unknown[] }>('GET', `/events/${eventId}/projects`);
    expect(after.ok && after.data.projects).toHaveLength(1);
  });

  it('a lost response AFTER the project was created: the retry returns the same project and requests nothing again', async () => {
    const eventId = await lockedEvent();
    const key = randomUUID();
    const dropResponse: ApiFn = async <T>(
      method: 'GET' | 'POST',
      path: string,
      body?: unknown,
      headers?: Readonly<Record<string, string>>,
    ) => {
      const real = await api<T>(method, path, body, headers);
      return method === 'POST'
        ? {
            ok: false,
            status: 503,
            code: 'API_UNREACHABLE',
            message: 'connection reset',
            issues: [],
          }
        : real;
    };
    const lost = await runSubmission(dropResponse, eventId, input(), key);
    expect(lost).toMatchObject({ kind: 'failed', outcomeUnknown: true });
    const listed = await api<{ projects: { id: string }[] }>('GET', `/events/${eventId}/projects`);
    const created = listed.ok ? listed.data.projects : [];
    expect(created).toHaveLength(1); // it WAS saved, although the caller never heard
    const retried = await run(eventId, {}, key);
    expect(retried).toMatchObject({
      kind: 'started',
      result: 'replayed',
      projectId: created[0]?.id,
    });
    expect(await snapshotsOf(created[0]?.id ?? '')).toHaveLength(2);
    expect((await detail(created[0]?.id ?? '')).sources).toHaveLength(2);
  });

  it('a form key is bound to its content: the same form with changed links is refused and points at what it already created', async () => {
    const eventId = await lockedEvent();
    const key = randomUUID();
    const first = await run(eventId, {}, key);
    if (first.kind !== 'started') throw new Error('not started');
    const changed = await run(
      eventId,
      { devpost: 'https://devpost.com/software/edited-after-submit' },
      key,
    );
    expect(changed).toMatchObject({ kind: 'failed', projectId: first.projectId });
    expect(changed.kind === 'failed' && changed.message).toMatch(/Reload the page/);
    expect((await detail(first.projectId)).sources.map((s) => s.url).sort()).toEqual(
      [DEVPOST, GITHUB].sort(),
    );
    const malformed = await run(eventId, {}, 'not-a-key');
    expect(malformed).toMatchObject({ kind: 'failed' });
    expect(malformed.kind === 'failed' && malformed.message).toMatch(/expired/);
  });

  it('an event without a locked Event Context cannot receive a project, and nothing is created', async () => {
    const created = await api<{ id: string }>('POST', '/events', {
      name: 'Unlocked Hackathon',
      slug: `unlocked-${String(Date.now())}`,
    });
    if (!created.ok) throw new Error(created.message);
    const before = (await db.select().from(projects)).length;
    const outcome = await run(created.data.id);
    expect(outcome).toMatchObject({ kind: 'failed' });
    expect(outcome.kind === 'failed' && outcome.message).toMatch(/no locked Event Context/);
    expect((await db.select().from(projects)).length).toBe(before);
    const missing = await run('5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e');
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
    const outcome = await run(eventId, overrides);
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
    const outcome = await runSubmission(anonymous, eventId, input(), randomUUID());
    expect(outcome.kind).toBe('failed');
    expect((await db.select().from(projects)).length).toBe(before);
  });
});
