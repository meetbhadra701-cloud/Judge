/*
 * P6B-beta2: correcting an erroneous submission by VOID AND REPLACE, through the real routes and the real database.
 *
 * Every test checks the PERSISTED rows, never a response alone. The properties:
 *   - the voided project's captured history (sources, snapshots, artifacts, assessments) is byte-for-byte what it was;
 *   - a voided project starts no new capture, source declaration or assessment, on every write path;
 *   - the links and label it owned are released to the replacement and to nobody before the void;
 *   - the whole correction is atomic, idempotent, and refuses (changing nothing) when it cannot be done safely;
 *   - the legacy project/source routes cannot take a link or a label that an active submission owns.
 */
import { randomUUID } from 'node:crypto';
import { ApiErrorBody } from '../../packages/schemas/src/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actors,
  analysisRuns,
  auditEvents,
  claims,
  graphExtractions,
  preInterviewAssessments,
  projectReplacements,
  projectSources,
  projectSubmissionClaims,
  projectSubmissions,
  projectVoids,
  projects,
  sourceSnapshotArtifacts,
  sourceSnapshots,
  type JudgeDatabase,
} from '../../packages/database/src/index.js';
import { sql } from '../../packages/database/src/testing/databases.js';
import { createLogger } from '../../packages/shared/src/index.js';
import { AssessmentService } from '../../apps/api/src/assessments/service.js';
import { buildApp, SERVICE_NAME, type ApiApp } from '../../apps/api/src/app.js';
import { SourceIngestionError } from '../../apps/api/src/projects/errors.js';
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
import { execute } from '../../apps/worker/src/testing/run.js';
import { captureSetup } from '../../apps/worker/src/testing/harness.js';

const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
let counter = 0;
const unique = (): string => (counter += 1).toString(36);
const gh = (name: string) => `https://github.com/synthetic/${name}`;
const dp = (name: string) => `https://devpost.com/software/${name}`;
const code = (body: unknown): string => ApiErrorBody.parse(body).error.code;

describe.each(testDatabaseTargets())('void and replace on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;
  let contendersDb: JudgeDatabase;
  let closeContenders: () => Promise<void> = () => Promise.resolve();
  let app: ApiApp;
  let eventContext: EventContextService;
  let organizerOne = '';
  let organizerTwo = '';

  beforeAll(async () => {
    testDb = await open();
    db = testDb.db;
    const extra = testDb.parallel?.();
    contendersDb = extra?.db ?? db;
    closeContenders = extra?.close ?? (() => Promise.resolve());
    const fixtures = await loadFixtures();
    eventContext = replayService(db, fixtures.values());
    app = buildApp({
      logger,
      db: contendersDb,
      verifier: fakeVerifier(),
      eventContext,
      projects: new ProjectService({ db: contendersDb }),
      assessments: new AssessmentService({ db: contendersDb, offline: null }),
    });
    for (const token of [TEST_TOKENS.organizer, TEST_TOKENS.secondOrganizer]) {
      await app.inject({ method: 'GET', url: '/events', headers: bearer(token) });
    }
    const rows = await db.select().from(actors);
    organizerOne = requireValue(rows.find((row) => row.subject === 'organizer-1')).id;
    organizerTwo = requireValue(rows.find((row) => row.subject === 'organizer-2')).id;
  });
  afterAll(async () => {
    await app.close();
    await closeContenders();
    await testDb.close();
  });

  async function lockedEvent(): Promise<string> {
    const fixtures = await loadFixtures();
    return (
      await lockedEventFromRecording(
        eventContext,
        requireValue(fixtures.get('fixture-e-multiple-tracks')),
      )
    ).eventId;
  }

  async function post(
    url: string,
    payload: unknown,
    key?: string | null,
    token: string = TEST_TOKENS.organizer,
  ) {
    const response = await app.inject({
      method: 'POST',
      url,
      headers: {
        ...bearer(token),
        ...(key === null ? {} : { 'idempotency-key': key ?? randomUUID() }),
      },
      payload: payload as object,
    });
    return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
  }
  async function get(url: string, token: string = TEST_TOKENS.organizer) {
    const response = await app.inject({ method: 'GET', url, headers: bearer(token) });
    return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
  }
  const submit = (eventId: string, github: string, devpost: string, name?: string) =>
    post(`/events/${eventId}/submissions`, {
      githubUrl: github,
      devpostUrl: devpost,
      ...(name === undefined ? {} : { name }),
    });
  const projectIdOf = (body: Record<string, unknown>): string =>
    (body['project'] as { id: string }).id;
  const voidRequest = (
    projectId: string,
    body: Record<string, unknown>,
    key?: string | null,
    token: string = TEST_TOKENS.organizer,
  ) => post(`/projects/${projectId}/void`, body, key, token);

  /** Lets the worker finish every pending capture (through the recorded fixture network), so the project may be voided. */
  async function finishCaptures(): Promise<void> {
    const setup = await captureSetup(db);
    await setup.loop.drain();
  }

  /** The complete captured history of a project, as stored: what a void must leave exactly as it was. */
  async function history(projectId: string) {
    const sources = (await db.select().from(projectSources)).filter(
      (r) => r.projectId === projectId,
    );
    const snapshots = (await db.select().from(sourceSnapshots)).filter(
      (r) => r.projectId === projectId,
    );
    const ids = new Set(snapshots.map((s) => s.id));
    const artifacts = (await db.select().from(sourceSnapshotArtifacts)).filter((r) =>
      ids.has(r.snapshotId),
    );
    const runs = (await db.select().from(analysisRuns)).filter((r) => r.projectId === projectId);
    const assessments = (await db.select().from(preInterviewAssessments)).filter(
      (r) => r.projectId === projectId,
    );
    const [submission] = (await db.select().from(projectSubmissions)).filter(
      (r) => r.projectId === projectId,
    );
    return JSON.stringify({ sources, snapshots, artifacts, runs, assessments, submission });
  }

  async function totals() {
    return {
      projects: (await db.select().from(projects)).length,
      sources: (await db.select().from(projectSources)).length,
      snapshots: (await db.select().from(sourceSnapshots)).length,
      runs: (await db.select().from(analysisRuns)).length,
      submissions: (await db.select().from(projectSubmissions)).length,
      claims: (await db.select().from(projectSubmissionClaims)).length,
      voids: (await db.select().from(projectVoids)).length,
      replacements: (await db.select().from(projectReplacements)).length,
    };
  }
  const claimsOf = async (projectId: string) =>
    (await db.select().from(projectSubmissionClaims))
      .filter((c) => c.projectId === projectId)
      .map((c) => [c.kind, c.value] as const)
      .sort();

  // -- the correction ----------------------------------------------------------------------------------------------------

  it('voids an erroneous submission and creates the corrected one in ONE operation, leaving the erroneous project’s history untouched', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const wrong = await submit(eventId, gh(`fix-${n}`), dp(`wrong-${n}`));
    expect(wrong.status).toBe(201);
    const wrongId = projectIdOf(wrong.body);
    await finishCaptures();
    const wrongHistory = await history(wrongId);
    const before = await totals();
    const key = randomUUID();

    const response = await voidRequest(
      wrongId,
      {
        reason: 'The Devpost page belongs to another team',
        replacement: { githubUrl: gh(`fix-${n}`), devpostUrl: dp(`right-${n}`) },
      },
      key,
    );
    expect(response.status).toBe(201);
    expect(response.body['result']).toBe('voided');
    const voidedView = response.body['project'] as {
      id: string;
      name: string;
      voided: { reason: string; nameBefore: string; replacedByProjectId: string | null };
    };
    const replacement = response.body['replacement'] as {
      result: string;
      project: { id: string; name: string; sources: { sourceType: string; url: string }[] };
      captureRuns: unknown[];
    };
    expect(voidedView.voided.reason).toBe('The Devpost page belongs to another team');
    expect(voidedView.voided.nameBefore).toBe(`synthetic/fix-${n}`);
    expect(voidedView.name).toMatch(/^synthetic\/fix-.+ \[voided [0-9a-f]{8}\]$/);
    expect(voidedView.voided.replacedByProjectId).toBe(replacement.project.id);
    expect(replacement.result).toBe('created');
    expect(replacement.captureRuns).toHaveLength(2);
    expect(replacement.project.name).toBe(`synthetic/fix-${n}`); // the label of the erroneous project is free again
    expect(replacement.project.sources.map((s) => [s.sourceType, s.url])).toEqual([
      ['github', gh(`fix-${n}`)],
      ['devpost', dp(`right-${n}`)],
    ]);

    // the erroneous project's history is exactly what it was: nothing deleted, nothing rewritten, no source re-pointed
    expect(await history(wrongId)).toBe(wrongHistory);
    // ... except its ownership: it holds no claim, the replacement holds all three
    expect(await claimsOf(wrongId)).toEqual([]);
    expect(await claimsOf(replacement.project.id)).toEqual([
      ['devpost', dp(`right-${n}`)],
      ['github', gh(`fix-${n}`)],
      ['name', `synthetic/fix-${n}`],
    ]);
    const after = await totals();
    expect(after).toEqual({
      projects: before.projects + 1,
      sources: before.sources + 2,
      snapshots: before.snapshots + 2,
      runs: before.runs + 2,
      submissions: before.submissions + 1,
      claims: before.claims - 3 + 3,
      voids: before.voids + 1,
      replacements: before.replacements + 1,
    });
    // recorded: who, why, when, and the link between the two projects
    const [voidRow] = (await db.select().from(projectVoids)).filter((v) => v.projectId === wrongId);
    expect(voidRow).toMatchObject({
      voidedByActorId: organizerOne,
      reason: 'The Devpost page belongs to another team',
      idempotencyKey: key,
    });
    const [link] = (await db.select().from(projectReplacements)).filter(
      (r) => r.voidedProjectId === wrongId,
    );
    expect(link?.replacementProjectId).toBe(replacement.project.id);
    const audit = (await db.select().from(auditEvents)).filter(
      (e) => e.entityId === wrongId || e.entityId === replacement.project.id,
    );
    expect(audit.map((e) => e.action)).toEqual(
      expect.arrayContaining(['project_voided', 'project_replaced', 'project_submission_created']),
    );
    // the organizer's free-text reason is never copied into the audit metadata
    expect(JSON.stringify(audit)).not.toContain('belongs to another team');
    // the read routes tell the same story
    const listed = await get(`/events/${eventId}/projects`);
    const names = (listed.body['projects'] as { id: string; voided: unknown }[]).filter((p) =>
      [wrongId, replacement.project.id].includes(p.id),
    );
    expect(names.map((p) => p.voided !== null).sort()).toEqual([false, true]);
  });

  it('is idempotent: the same key and content returns the original result and writes nothing; the same key with other content is refused', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const wrongId = projectIdOf(
      (await submit(eventId, gh(`idem-${n}`), dp(`idem-wrong-${n}`))).body,
    );
    await finishCaptures();
    const key = randomUUID();
    const body = {
      reason: 'wrong page',
      replacement: { githubUrl: gh(`idem-${n}`), devpostUrl: dp(`idem-right-${n}`) },
    };
    const first = await voidRequest(wrongId, body, key);
    expect(first.status).toBe(201);
    const before = await totals();
    const again = await voidRequest(wrongId, body, key);
    expect(again.status).toBe(200);
    expect(again.body['result']).toBe('replayed');
    expect(projectIdOf(again.body['replacement'] as Record<string, unknown>)).toBe(
      projectIdOf(first.body['replacement'] as Record<string, unknown>),
    );
    expect(await totals()).toEqual(before);
    const other = await voidRequest(wrongId, { ...body, reason: 'a different reason' }, key);
    expect([other.status, code(other.body)]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
    const otherTarget = await voidRequest(
      wrongId,
      {
        reason: 'wrong page',
        replacement: { githubUrl: gh(`idem-${n}`), devpostUrl: dp(`idem-zzz-${n}`) },
      },
      key,
    );
    expect([otherTarget.status, code(otherTarget.body)]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
    expect(await totals()).toEqual(before);
  });

  it('a second correction of an already voided project (another key) is refused and changes nothing', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const wrongId = projectIdOf((await submit(eventId, gh(`twice-${n}`), dp(`twice-${n}`))).body);
    await finishCaptures();
    expect((await voidRequest(wrongId, { reason: 'first' })).status).toBe(201);
    const before = await totals();
    const second = await voidRequest(wrongId, {
      reason: 'second',
      replacement: { githubUrl: gh(`twice-${n}-b`), devpostUrl: dp(`twice-${n}-b`) },
    });
    expect([second.status, code(second.body)]).toEqual([409, 'PROJECT_ALREADY_VOIDED']);
    expect(await totals()).toEqual(before);
  });

  it('a void without a replacement releases the links; the same pair can then be submitted as a new project', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const wrongId = projectIdOf((await submit(eventId, gh(`bare-${n}`), dp(`bare-${n}`))).body);
    await finishCaptures();
    const refused = await submit(eventId, gh(`bare-${n}`), dp(`bare-other-${n}`));
    expect([refused.status, code(refused.body)]).toEqual([409, 'SUBMISSION_CONFLICT']);
    const response = await voidRequest(wrongId, { reason: 'duplicate entry' });
    expect(response.status).toBe(201);
    expect(response.body['replacement']).toBeNull();
    expect(
      (response.body['project'] as { voided: { replacedByProjectId: unknown } }).voided
        .replacedByProjectId,
    ).toBeNull();
    const fresh = await submit(eventId, gh(`bare-${n}`), dp(`bare-${n}`));
    expect(fresh.status).toBe(201); // NOT converged on the voided project
    expect(projectIdOf(fresh.body)).not.toBe(wrongId);
  });

  // -- refusals leave nothing behind ------------------------------------------------------------------------------------

  it('refuses while a capture of the project is still pending, changes nothing, and succeeds once the work has finished', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const wrongId = projectIdOf((await submit(eventId, gh(`busy-${n}`), dp(`busy-${n}`))).body);
    // captures were just requested and no worker has run
    const before = await totals();
    const busy = await voidRequest(wrongId, {
      reason: 'wrong',
      replacement: { githubUrl: gh(`busy-${n}`), devpostUrl: dp(`busy-right-${n}`) },
    });
    expect([busy.status, code(busy.body)]).toEqual([409, 'PROJECT_HAS_PENDING_WORK']);
    expect(await totals()).toEqual(before);
    expect((await get(`/projects/${wrongId}`)).body['voided']).toBeNull();
    await finishCaptures();
    const done = await voidRequest(wrongId, {
      reason: 'wrong',
      replacement: { githubUrl: gh(`busy-${n}`), devpostUrl: dp(`busy-right-${n}`) },
    });
    expect(done.status).toBe(201);
  });

  describe('recovery without a worker: cancelPendingWork (P6B-beta3)', () => {
    const pendingOf = async (projectId: string) =>
      (await db.select().from(sourceSnapshots)).filter(
        (r) => r.projectId === projectId && r.status === 'pending',
      );

    it('cancels the capture requests no worker started, with the void and the replacement, and records exactly what it did', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const wrongId = projectIdOf((await submit(eventId, gh(`nw-${n}`), dp(`nw-${n}`))).body);
      const pendingBefore = await pendingOf(wrongId);
      expect(pendingBefore).toHaveLength(2); // no worker has run: both captures wait

      const refused = await voidRequest(wrongId, { reason: 'wrong repository' });
      expect([refused.status, code(refused.body)]).toEqual([409, 'PROJECT_HAS_PENDING_WORK']);
      expect(await pendingOf(wrongId)).toHaveLength(2); // the refusal changed nothing

      const key = randomUUID();
      const body = {
        reason: 'wrong repository',
        cancelPendingWork: true,
        replacement: { githubUrl: gh(`nw-fix-${n}`), devpostUrl: dp(`nw-fix-${n}`) },
      };
      const response = await voidRequest(wrongId, body, key);
      expect(response.status).toBe(201);
      expect(response.body['cancelledPending']).toEqual({ captures: 2, assessments: 0 });

      expect(await pendingOf(wrongId)).toHaveLength(0);
      const snapshots = (await db.select().from(sourceSnapshots)).filter(
        (r) => r.projectId === wrongId,
      );
      expect(snapshots).toHaveLength(2);
      for (const snapshot of snapshots) {
        expect(snapshot).toMatchObject({
          status: 'failed',
          failureCategory: 'internal_error',
          failureMetadata: { reason: 'cancelled_by_void' },
        });
        expect(snapshot.completedAt).not.toBeNull();
      }
      const runs = (await db.select().from(analysisRuns)).filter((r) => r.projectId === wrongId);
      expect(runs.map((r) => r.state)).toEqual(['cancelled', 'cancelled']);
      expect(
        runs.every(
          (r) => r.failureCategory === null && r.startedAt !== null && r.finishedAt !== null,
        ),
      ).toBe(true);
      // no artifact was fabricated, and the audit event says how much was cancelled (counts only)
      expect(
        (await db.select().from(sourceSnapshotArtifacts)).filter((a) =>
          snapshots.some((x) => x.id === a.snapshotId),
        ),
      ).toHaveLength(0);
      const voidEvent = (await db.select().from(auditEvents)).filter(
        (e) => e.entityId === wrongId && e.action === 'project_voided',
      );
      expect(voidEvent).toHaveLength(1);
      expect(voidEvent[0]?.metadata).toMatchObject({
        cancelledCaptures: 2,
        cancelledAssessments: 0,
      });

      // the replacement's own captures are untouched and pending; the displayed snapshot says what happened
      const replacementId = projectIdOf(response.body['replacement'] as Record<string, unknown>);
      expect(await pendingOf(replacementId)).toHaveLength(2);
      const detail = (await get(`/projects/${wrongId}`)).body as {
        sources: { latestSnapshot: { failureReason: string | null } }[];
      };
      expect(detail.sources.map((x) => x.latestSnapshot.failureReason)).toEqual([
        'cancelled_by_void',
        'cancelled_by_void',
      ]);

      // a retry of the same request (lost response) answers the original result and cancels nothing more
      const again = await voidRequest(wrongId, body, key);
      expect(again.status).toBe(200);
      expect(again.body['result']).toBe('replayed');
      expect(again.body['cancelledPending']).toEqual({ captures: 0, assessments: 0 });
      expect(await pendingOf(replacementId)).toHaveLength(2);
    });

    it('never cancels a request a worker has started: that still blocks the void, and nothing is changed', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const wrongId = projectIdOf((await submit(eventId, gh(`nr-${n}`), dp(`nr-${n}`))).body);
      const runs = (await db.select().from(analysisRuns)).filter((r) => r.projectId === wrongId);
      const target = requireValue(runs[0]);
      await db.execute(
        sql`UPDATE analysis_runs SET state = 'running', started_at = now(), lease_token = ${randomUUID()}, lease_expires_at = now() + interval '10 minutes' WHERE id = ${target.id}`,
      );
      const before = await totals();
      const response = await voidRequest(wrongId, { reason: 'wrong', cancelPendingWork: true });
      expect([response.status, code(response.body)]).toEqual([409, 'PROJECT_HAS_PENDING_WORK']);
      expect(await totals()).toEqual(before);
      expect(await pendingOf(wrongId)).toHaveLength(2); // the unstarted one was not cancelled either: the correction is all or nothing
      expect((await get(`/projects/${wrongId}`)).body['voided']).toBeNull();
    });

    it('a correction that cannot be completed cancels nothing', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const wrongId = projectIdOf((await submit(eventId, gh(`na-${n}`), dp(`na-${n}`))).body);
      const otherId = projectIdOf(
        (await submit(eventId, gh(`na-taken-${n}`), dp(`na-taken-${n}`))).body,
      );
      expect(otherId).not.toBe(wrongId);
      const response = await voidRequest(wrongId, {
        reason: 'wrong',
        cancelPendingWork: true,
        replacement: { githubUrl: gh(`na-taken-${n}`), devpostUrl: dp(`na-new-${n}`) },
      });
      expect([response.status, code(response.body)]).toEqual([409, 'SUBMISSION_CONFLICT']);
      expect(await pendingOf(wrongId)).toHaveLength(2);
      expect((await get(`/projects/${wrongId}`)).body['voided']).toBeNull();
    });

    it('the flag is part of the request: the same key with and without it is a different request', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const wrongId = projectIdOf((await submit(eventId, gh(`nk-${n}`), dp(`nk-${n}`))).body);
      const key = randomUUID();
      const first = await voidRequest(wrongId, { reason: 'wrong', cancelPendingWork: true }, key);
      expect(first.status).toBe(201);
      const second = await voidRequest(wrongId, { reason: 'wrong' }, key);
      expect([second.status, code(second.body)]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
    });
  });

  it('a replacement that cannot be created refuses the WHOLE correction: the project is not voided and its claims are kept', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const wrongId = projectIdOf((await submit(eventId, gh(`atomic-${n}`), dp(`atomic-${n}`))).body);
    const otherId = projectIdOf((await submit(eventId, gh(`taken-${n}`), dp(`taken-${n}`))).body);
    await finishCaptures();
    const before = await totals();
    const claimsBefore = await claimsOf(wrongId);
    const historyBefore = await history(wrongId);

    // (a) the corrected pair overlaps ANOTHER active submission in one link
    const overlap = await voidRequest(wrongId, {
      reason: 'wrong',
      replacement: { githubUrl: gh(`taken-${n}`), devpostUrl: dp(`atomic-new-${n}`) },
    });
    expect([overlap.status, code(overlap.body)]).toEqual([409, 'SUBMISSION_CONFLICT']);
    // (b) the corrected pair IS another active submission
    const same = await voidRequest(wrongId, {
      reason: 'wrong',
      replacement: { githubUrl: gh(`taken-${n}`), devpostUrl: dp(`taken-${n}`) },
    });
    expect([same.status, code(same.body)]).toEqual([409, 'SUBMISSION_CONFLICT']);
    expect(ApiErrorBody.parse(same.body).error.details).toEqual({ projectId: otherId });
    // (c) a link the server will not accept
    const invalid = await voidRequest(wrongId, {
      reason: 'wrong',
      replacement: { githubUrl: 'https://example.com/a/b', devpostUrl: dp(`atomic-new-${n}`) },
    });
    expect([invalid.status, code(invalid.body)]).toEqual([422, 'INVALID_SOURCE_URL']);
    // (d) a label that another active project already uses
    const named = await voidRequest(wrongId, {
      reason: 'wrong',
      replacement: {
        githubUrl: gh(`atomic-new-${n}`),
        devpostUrl: dp(`atomic-new-${n}`),
        name: `SYNTHETIC/TAKEN-${n}`.toLowerCase(),
      },
    });
    expect([named.status, code(named.body)]).toEqual([409, 'PROJECT_NAME_TAKEN']);

    expect(await totals()).toEqual(before);
    expect(await claimsOf(wrongId)).toEqual(claimsBefore);
    expect(await history(wrongId)).toBe(historyBefore);
    expect((await get(`/projects/${wrongId}`)).body['voided']).toBeNull();
  });

  it('is organizer-only, needs an Idempotency-Key, and refuses unknown, malformed or hostile input without a server error', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const wrongId = projectIdOf((await submit(eventId, gh(`guard-${n}`), dp(`guard-${n}`))).body);
    await finishCaptures();
    const before = await totals();
    const valid = { reason: 'wrong' };
    expect((await voidRequest(wrongId, valid, randomUUID(), TEST_TOKENS.judge)).status).toBe(403);
    expect((await voidRequest(wrongId, valid, randomUUID(), TEST_TOKENS.noRole)).status).toBe(403);
    const anonymous = await app.inject({
      method: 'POST',
      url: `/projects/${wrongId}/void`,
      headers: { 'idempotency-key': randomUUID() },
      payload: valid,
    });
    expect(anonymous.statusCode).toBe(401);
    expect((await voidRequest(wrongId, valid, null)).status).toBe(400);
    expect((await voidRequest(wrongId, valid, 'not-a-uuid')).status).toBe(400);
    for (const body of [
      {},
      { reason: '' },
      { reason: '   ' },
      { reason: 'a\u0000b' }, // NUL: PostgreSQL text cannot hold it
      { reason: 'two\nlines' },
      { reason: 'x'.repeat(1_001) },
      { reason: 'ok', extra: true },
      { reason: 'ok', replacement: { githubUrl: gh('a'), devpostUrl: dp('a'), name: 'n\u0000' } },
      { reason: 'ok', replacement: { githubUrl: gh('a') } },
    ]) {
      const response = await voidRequest(wrongId, body);
      expect([response.status, code(response.body)], JSON.stringify(body)).toEqual([
        400,
        'INVALID_REQUEST',
      ]);
    }
    expect((await voidRequest(randomUUID(), valid)).status).toBe(404);
    expect(await totals()).toEqual(before);
  });

  // -- a voided project starts nothing ------------------------------------------------------------------------------------

  it('a voided project accepts no capture, no source and no assessment on any write path, and stays fully readable', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const wrongId = projectIdOf((await submit(eventId, gh(`inert-${n}`), dp(`inert-${n}`))).body);
    await finishCaptures();
    expect((await voidRequest(wrongId, { reason: 'wrong' })).status).toBe(201);
    const detail = (await get(`/projects/${wrongId}`)).body as {
      sources: { id: string }[];
    };
    const sourceId = requireValue(detail.sources[0]).id;
    const before = await totals();
    const attempts = [
      post(`/projects/${wrongId}/captures`, {}, null),
      post(`/projects/${wrongId}/sources/${sourceId}/captures`, {}, null),
      post(
        `/projects/${wrongId}/sources`,
        { sourceType: 'deployment', url: 'https://example.org/app' },
        null,
      ),
      post(`/projects/${wrongId}/sources`, { sourceType: 'github', url: gh(`inert-${n}`) }, null),
      post(`/projects/${wrongId}/assessments`, { mode: 'assess' }),
    ];
    for (const attempt of attempts) {
      const response = await attempt;
      // an assessment route answers 503 first when no provider is configured; every other write path says the project is voided
      expect([409, 503], JSON.stringify(response.body)).toContain(response.status);
      if (response.status === 409) expect(code(response.body)).toBe('PROJECT_VOIDED');
    }
    expect(await totals()).toEqual(before);
    // history stays readable
    expect((await get(`/projects/${wrongId}`)).status).toBe(200);
    expect((await get(`/projects/${wrongId}/snapshots`)).status).toBe(200);
    expect((await get(`/projects/${wrongId}/sources`)).status).toBe(200);
  });

  it('the database refuses new work for a voided project even if the application were bypassed', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const wrongId = projectIdOf((await submit(eventId, gh(`direct-${n}`), dp(`direct-${n}`))).body);
    await finishCaptures();
    await voidRequest(wrongId, { reason: 'wrong' });
    const [source] = (await db.select().from(projectSources)).filter(
      (s) => s.projectId === wrongId,
    );
    const before = await totals();
    await expect(
      db.insert(sourceSnapshots).values({
        projectId: wrongId,
        projectSourceId: requireValue(source).id,
        captureNumber: 99,
        sourceType: 'github',
        sourceUrl: requireValue(source).url,
        status: 'pending',
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(projectSources).values({
        projectId: wrongId,
        sourceType: 'deployment',
        url: 'https://example.org/late',
        position: 9,
      }),
    ).rejects.toThrow();
    expect(await totals()).toEqual(before);
  });

  it('a project that was ASSESSED can be voided: its assessments, unknowns and graph are untouched and still read exactly as before', async () => {
    const run = await execute(db, { worldOptions: { sources: ['devpost', 'github'] } });
    expect(run.outcome.kind).toBe('succeeded');
    const projectId = run.world.project.id;
    const [assessment] = await run.assessments();
    const assessmentId = requireValue(assessment).id;
    const read = async () => ({
      list: (await get(`/projects/${projectId}/assessments`)).body,
      detail: (await get(`/projects/${projectId}/assessments/${assessmentId}`)).body,
      unknowns: (await get(`/projects/${projectId}/assessments/${assessmentId}/unknowns`)).body,
    });
    const graphRows = async () => ({
      claims: (await db.select().from(claims)).filter((c) => c.projectId === projectId).length,
      extractions: (await db.select().from(graphExtractions)).filter(
        (e) => e.projectId === projectId,
      ).length,
    });
    const before = await read();
    const graphBefore = await graphRows();
    const historyBefore = await history(projectId);
    const response = await voidRequest(projectId, { reason: 'the wrong repository was submitted' });
    expect(response.status).toBe(201);
    expect(await history(projectId)).toBe(historyBefore);
    expect(await graphRows()).toEqual(graphBefore);
    const after = await read();
    // the project's name changed (the label is marked), nothing else about its reports did
    expect(after.detail).toEqual(before.detail);
    expect(after.unknowns).toEqual(before.unknowns);
    expect((after.list['assessments'] as unknown[]).length).toBe(
      (before.list['assessments'] as unknown[]).length,
    );
  });

  it('never touches another project or another event', async () => {
    const eventId = await lockedEvent();
    const otherEventId = await lockedEvent();
    const n = unique();
    // the SAME pair submitted in two events: independent submissions
    const here = projectIdOf((await submit(eventId, gh(`iso-${n}`), dp(`iso-${n}`))).body);
    const there = projectIdOf((await submit(otherEventId, gh(`iso-${n}`), dp(`iso-${n}`))).body);
    const bystander = projectIdOf((await submit(eventId, gh(`by-${n}`), dp(`by-${n}`))).body);
    await finishCaptures();
    const thereHistory = await history(there);
    const bystanderHistory = await history(bystander);
    const thereClaims = await claimsOf(there);
    const bystanderClaims = await claimsOf(bystander);
    expect(
      (
        await voidRequest(here, {
          reason: 'wrong',
          replacement: { githubUrl: gh(`iso-${n}`), devpostUrl: dp(`iso-right-${n}`) },
        })
      ).status,
    ).toBe(201);
    expect(await history(there)).toBe(thereHistory);
    expect(await history(bystander)).toBe(bystanderHistory);
    expect(await claimsOf(there)).toEqual(thereClaims);
    expect(await claimsOf(bystander)).toEqual(bystanderClaims);
    expect((await get(`/projects/${there}`)).body['voided']).toBeNull();
    // a void addressed to a project cannot name a replacement that collides with another event’s data: events are independent
    const crossEvent = await voidRequest(bystander, {
      reason: 'wrong',
      replacement: { githubUrl: gh(`iso-${n}`), devpostUrl: dp(`iso-right-${n}`) },
    });
    expect([crossEvent.status, code(crossEvent.body)]).toEqual([409, 'SUBMISSION_CONFLICT']);
  });

  // -- the legacy routes cannot bypass the identity -----------------------------------------------------------------------

  it('the earlier project and source routes cannot take a link or a label that an active submission owns (until it is voided)', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const owner = projectIdOf(
      (await submit(eventId, gh(`own-${n}`), dp(`own-${n}`), `Owner ${n}`)).body,
    );
    const legacy = await post(`/events/${eventId}/projects`, { name: `Legacy ${n}` }, null);
    expect(legacy.status).toBe(201);
    const legacyId = (legacy.body as unknown as { id: string }).id;
    const before = await totals();

    for (const [sourceType, url] of [
      ['github', gh(`own-${n}`)],
      ['devpost', dp(`own-${n}`)],
    ] as const) {
      const taken = await post(`/projects/${legacyId}/sources`, { sourceType, url }, null);
      expect([taken.status, code(taken.body)], sourceType).toEqual([409, 'SUBMISSION_CONFLICT']);
      expect(ApiErrorBody.parse(taken.body).error.details).toEqual({
        sourceType,
        projectIds: [owner],
      });
    }
    // a label that differs only by case
    const renamed = await post(`/events/${eventId}/projects`, { name: `OWNER ${n}` }, null);
    expect([renamed.status, code(renamed.body)]).toEqual([409, 'PROJECT_NAME_TAKEN']);
    expect(await totals()).toEqual(before);

    // once the owner is voided and its captures have finished, the links and the label are free
    await finishCaptures();
    expect((await voidRequest(owner, { reason: 'wrong' })).status).toBe(201);
    expect(
      (
        await post(
          `/projects/${legacyId}/sources`,
          { sourceType: 'github', url: gh(`own-${n}`) },
          null,
        )
      ).status,
    ).toBe(201);
    expect((await post(`/events/${eventId}/projects`, { name: `OWNER ${n}` }, null)).status).toBe(
      201,
    );
  });

  it('a project name or team name with a control character is a 400, never a 500, on every route that accepts one', async () => {
    const eventId = await lockedEvent();
    const before = await totals();
    for (const name of [
      'bad\u0000name',
      'two\nlines',
      'tab\there',
      'a\u2028x',
      'a\u2029x',
      'bell\u0007',
    ]) {
      const create = await post(`/events/${eventId}/projects`, { name }, null);
      expect([create.status, code(create.body)], JSON.stringify(name)).toEqual([
        400,
        'INVALID_REQUEST',
      ]);
      const team = await post(
        `/events/${eventId}/projects`,
        { name: 'fine', teamName: name },
        null,
      );
      expect(team.status).toBe(400);
      const submitted = await submit(eventId, gh('nul'), dp('nul'), name);
      expect([submitted.status, code(submitted.body)], JSON.stringify(name)).toEqual([
        400,
        'INVALID_REQUEST',
      ]);
    }
    expect(await totals()).toEqual(before);
  });

  // -- the integrity report ------------------------------------------------------------------------------------------------

  it('the integrity report does not list a voided project, and counts it', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const mixed = (await post(`/events/${eventId}/projects`, { name: `Mixed ${n}` }, null))
      .body as unknown as {
      id: string;
    };
    await post(
      `/projects/${mixed.id}/sources`,
      { sourceType: 'github', url: gh(`mix-${n}`) },
      null,
    );
    await post(
      `/projects/${mixed.id}/sources`,
      { sourceType: 'devpost', url: dp(`mix-${n}-a`) },
      null,
    );
    await post(
      `/projects/${mixed.id}/sources`,
      { sourceType: 'devpost', url: dp(`mix-${n}-b`) },
      null,
    );
    const flagged = (await get(`/events/${eventId}/submission-integrity`)).body as {
      projectsChecked: number;
      projectsVoided: number;
      findings: { kind: string; projectIds: string[] }[];
    };
    expect(flagged.findings.some((f) => f.projectIds.includes(mixed.id))).toBe(true);
    expect(flagged.projectsVoided).toBe(0);
    expect((await voidRequest(mixed.id, { reason: 'mixed project' })).status).toBe(201);
    const after = (await get(`/events/${eventId}/submission-integrity`)).body as typeof flagged;
    expect(after.findings.some((f) => f.projectIds.includes(mixed.id))).toBe(false);
    expect(after.projectsVoided).toBe(1);
    expect(after.projectsChecked).toBe(flagged.projectsChecked - 1);
  });

  // -- concurrency ----------------------------------------------------------------------------------------------------------

  describe('concurrent corrections', () => {
    const outcomeOf = async (work: Promise<unknown>) => {
      try {
        const value = (await work) as { result: string };
        return { ok: true as const, result: value.result };
      } catch (error) {
        if (error instanceof SourceIngestionError) return { ok: false as const, code: error.code };
        throw error;
      }
    };

    it('two different corrections of the SAME project: exactly one voids it, the other is told it is already voided', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const wrongId = projectIdOf((await submit(eventId, gh(`rv-${n}`), dp(`rv-${n}`))).body);
      await finishCaptures();
      const service = new ProjectService({ db: contendersDb });
      const outcomes = await Promise.all([
        outcomeOf(
          service.voidProject(
            wrongId,
            {
              reason: 'one',
              replacement: { githubUrl: gh(`rv-${n}`), devpostUrl: dp(`rv-a-${n}`) },
            },
            organizerOne,
            randomUUID(),
          ),
        ),
        outcomeOf(
          service.voidProject(
            wrongId,
            {
              reason: 'two',
              replacement: { githubUrl: gh(`rv-${n}`), devpostUrl: dp(`rv-b-${n}`) },
            },
            organizerTwo,
            randomUUID(),
          ),
        ),
      ]);
      expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
      expect(outcomes.filter((o) => !o.ok)).toEqual([
        { ok: false, code: 'PROJECT_ALREADY_VOIDED' },
      ]);
      expect(
        (await db.select().from(projectVoids)).filter((v) => v.projectId === wrongId),
      ).toHaveLength(1);
      const replacements = (await db.select().from(projectReplacements)).filter(
        (r) => r.voidedProjectId === wrongId,
      );
      expect(replacements).toHaveLength(1);
      // exactly one replacement project exists for the pair: the loser created nothing
      const sources = (await db.select().from(projectSources)).filter(
        (s) => s.url === gh(`rv-${n}`),
      );
      expect(sources).toHaveLength(2); // the voided project's and the winner's
    });

    it('the same correction sent twice at once: one voids, the other replays, one replacement', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const wrongId = projectIdOf((await submit(eventId, gh(`rs-${n}`), dp(`rs-${n}`))).body);
      await finishCaptures();
      const service = new ProjectService({ db: contendersDb });
      const key = randomUUID();
      const input = {
        reason: 'same',
        replacement: { githubUrl: gh(`rs-${n}`), devpostUrl: dp(`rs-right-${n}`) },
      };
      const outcomes = await Promise.all([
        outcomeOf(service.voidProject(wrongId, input, organizerOne, key)),
        outcomeOf(service.voidProject(wrongId, input, organizerOne, key)),
      ]);
      expect(outcomes.every((o) => o.ok)).toBe(true);
      expect(outcomes.map((o) => (o.ok ? o.result : '')).sort()).toEqual(['replayed', 'voided']);
      expect(
        (await db.select().from(projectReplacements)).filter((r) => r.voidedProjectId === wrongId),
      ).toHaveLength(1);
      expect(
        (await db.select().from(projectSubmissions)).filter(
          (s) => s.devpostUrl === dp(`rs-right-${n}`),
        ),
      ).toHaveLength(1);
    });

    it('two projects corrected into the SAME pair: exactly one correction wins, the loser’s project is NOT voided', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const a = projectIdOf((await submit(eventId, gh(`ra-${n}`), dp(`ra-${n}`))).body);
      const b = projectIdOf((await submit(eventId, gh(`rb-${n}`), dp(`rb-${n}`))).body);
      await finishCaptures();
      const service = new ProjectService({ db: contendersDb });
      const target = { githubUrl: gh(`target-${n}`), devpostUrl: dp(`target-${n}`) };
      const outcomes = await Promise.all([
        outcomeOf(
          service.voidProject(a, { reason: 'a', replacement: target }, organizerOne, randomUUID()),
        ),
        outcomeOf(
          service.voidProject(b, { reason: 'b', replacement: target }, organizerTwo, randomUUID()),
        ),
      ]);
      expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
      const loser = outcomes.find((o) => !o.ok);
      expect(loser).toMatchObject({ ok: false, code: 'SUBMISSION_CONFLICT' });
      const voidedIds = (await db.select().from(projectVoids)).map((v) => v.projectId);
      expect([a, b].filter((id) => voidedIds.includes(id))).toHaveLength(1);
      // the loser still owns its original links
      const loserId = voidedIds.includes(a) ? b : a;
      expect((await claimsOf(loserId)).map(([kind]) => kind).sort()).toEqual([
        'devpost',
        'github',
        'name',
      ]);
      expect(
        (await db.select().from(projectSubmissions)).filter(
          (s) => s.githubUrl === target.githubUrl,
        ),
      ).toHaveLength(1);
    });

    it('a capture request racing a void: either the capture is queued and the void refused, or the void wins and the capture is refused -- never both', async () => {
      for (let round = 0; round < 4; round += 1) {
        const eventId = await lockedEvent();
        const n = unique();
        const projectId = projectIdOf((await submit(eventId, gh(`rc-${n}`), dp(`rc-${n}`))).body);
        await finishCaptures();
        const service = new ProjectService({ db: contendersDb });
        const [voided, captured] = await Promise.all([
          outcomeOf(service.voidProject(projectId, { reason: 'race' }, organizerOne, randomUUID())),
          outcomeOf(
            service.requestAllCaptures(projectId, organizerTwo).then(() => ({ result: 'queued' })),
          ),
        ]);
        const pending = (await db.select().from(sourceSnapshots)).filter(
          (s) => s.projectId === projectId && s.status === 'pending',
        );
        const voidRows = (await db.select().from(projectVoids)).filter(
          (v) => v.projectId === projectId,
        );
        // the invariant: a voided project never has work in flight
        expect(voidRows.length > 0 && pending.length > 0, `round ${String(round)}`).toBe(false);
        expect(voided.ok && captured.ok, `round ${String(round)}`).toBe(false);
        expect(voided.ok || captured.ok).toBe(true);
        if (!voided.ok) expect(voided).toMatchObject({ code: 'PROJECT_HAS_PENDING_WORK' });
        if (!captured.ok) expect(captured).toMatchObject({ code: 'PROJECT_VOIDED' });
      }
    });
  });
});
