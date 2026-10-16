import { randomUUID } from 'node:crypto';
import { sql } from '../../packages/database/src/testing/databases.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  analysisRuns,
  auditEvents,
  events,
  projectSubmissionRequests,
  projectSources,
  projectSubmissions,
  projectTrackSelections,
  projects,
  type JudgeDatabase,
} from '../../packages/database/src/index.js';
import { ApiErrorBody } from '../../packages/schemas/src/index.js';
import { createLogger } from '../../packages/shared/src/index.js';
import { AssessmentService } from '../../apps/api/src/assessments/service.js';
import { buildApp, SERVICE_NAME, type ApiApp } from '../../apps/api/src/app.js';
import { ProjectService } from '../../apps/api/src/projects/service.js';
import {
  bearer,
  fakeVerifier,
  loadFixtures,
  replayService,
  TEST_TOKENS,
  testDatabaseTargets,
  type TestDatabase,
} from '../../apps/api/src/testing/harness.js';
import {
  seedLaterCapture,
  seedLockedContext,
  type WorldOptions,
} from '../../apps/worker/src/testing/assessment-world.js';

/*
 * P6D (P2-1): the normal submission flow declares the project's tracks. Every test checks PERSISTED rows, not a response alone. The shape of
 * the feature is "the same track semantics as creating a project directly, in the one atomic submission, with the context the submitter saw".
 */

const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
let counter = 0;
const unique = (): string => (counter += 1).toString(36) + Date.now().toString(36);
const gh = (name: string) => `https://github.com/synthetic/${name}`;
const dp = (name: string) => `https://devpost.com/software/${name}`;
const MODELS = {
  extraction: 'claude-haiku-5-5',
  assessment: 'claude-sonnet-5-5',
  critic: 'claude-sonnet-5-5',
};

const code = (body: unknown): string => ApiErrorBody.parse(body).error.code;

/** The parts of the API answers these tests read (loosely typed on purpose: an error answer simply lacks the success fields). */
interface Reply {
  result: string;
  project: { id: string; tracks: { trackKey: string }[] };
  sources: {
    id: string;
    sourceType: string;
    latestSnapshot: { status: string } | null;
    latestUsableSnapshot: { id: string; status: string } | null;
  }[];
  replacement: { project: { id: string } };
  error: { message: string };
  [key: string]: unknown;
}
const NO_RULES: WorldOptions = { rules: [] };

describe.each(testDatabaseTargets())('P6D submission tracks on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;
  let app: ApiApp;

  beforeAll(async () => {
    testDb = await open();
    db = testDb.db;
    const fixtures = await loadFixtures();
    app = buildApp({
      logger,
      db,
      verifier: fakeVerifier(),
      eventContext: replayService(db, fixtures.values()),
      projects: new ProjectService({ db }),
      assessments: new AssessmentService({
        db,
        offline: { provider: { id: 'scripted', mode: 'scripted' }, models: MODELS },
      }),
    });
  });
  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  /** An event whose locked Event Context has exactly the given shape (the seeding helper writes it the way the M1 lock does). */
  async function event(options: WorldOptions) {
    const n = unique();
    const [row] = await db
      .insert(events)
      .values({ name: `Track Event ${n}`, slug: `track-event-${n}` })
      .returning();
    if (!row) throw new Error('event');
    const context = await seedLockedContext(db, row.id, options);
    return { eventId: row.id, versionId: context.versionId };
  }

  async function submit(
    eventId: string,
    body: Record<string, unknown>,
    options: { key?: string; token?: string | null } = {},
  ) {
    const token = options.token === undefined ? TEST_TOKENS.organizer : options.token;
    const response = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/submissions`,
      headers: {
        ...(token ? bearer(token) : {}),
        'idempotency-key': options.key ?? randomUUID(),
      },
      payload: body,
    });
    return { status: response.statusCode, body: response.json<Reply>() };
  }
  const pair = () => {
    const n = unique();
    return { githubUrl: gh(`repo-${n}`), devpostUrl: dp(`proj-${n}`) };
  };
  const declared = async (projectId: string) =>
    (
      await db
        .select({ key: projectTrackSelections.trackKey })
        .from(projectTrackSelections)
        .where(sql`${projectTrackSelections.projectId} = ${projectId}`)
    )
      .map((row) => row.key)
      .sort();
  const rowsFor = async (eventId: string) => ({
    projects: (await db.select().from(projects)).filter((p) => p.eventId === eventId).length,
    submissions: (await db.select().from(projectSubmissions)).filter((p) => p.eventId === eventId)
      .length,
    requests: (await db.select().from(projectSubmissionRequests)).length,
  });
  /** Assessment request on a submitted project, over HTTP, after a captured source exists (the capture worker's output is seeded). */
  async function requestAssessment(projectId: string) {
    const [source] = (await db.select().from(projectSources)).filter(
      (row) => row.projectId === projectId && row.sourceType === 'devpost',
    );
    if (!source) throw new Error('no declared source');
    await seedLaterCapture(db, { id: projectId }, source, 'captured', [
      {
        key: 'submission.txt',
        kind: 'submission_text',
        mediaType: 'text/plain',
        text: 'A synthetic submission text that is long enough to be a statement.',
      },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/assessments`,
      headers: { ...bearer(TEST_TOKENS.organizer), 'idempotency-key': randomUUID() },
      payload: { mode: 'assess' },
    });
    return { status: response.statusCode, body: response.json<Reply>() };
  }

  it('global-rule event: a submission without a track field (an older client) still works and declares no track', async () => {
    const { eventId } = await event({ trackKeys: ['health'] });
    const result = await submit(eventId, pair());
    expect(result.status).toBe(201);
    expect(await declared(result.body.project.id)).toEqual([]);
    expect(result.body.project.tracks).toEqual([]);
    // the global explicit rule is reference evidence: the assessment request is accepted without any track
    expect((await requestAssessment(result.body.project.id)).status).toBe(202);
  });

  it('track-only event: without a track the assessment is refused with the real missing requirement; WITH the track it proceeds', async () => {
    const { eventId } = await event({ ...NO_RULES, trackKeys: ['health', 'climate'] });
    const without = await submit(eventId, { ...pair(), trackKeys: [] });
    expect(without.status).toBe(201);
    const refused = await requestAssessment(without.body.project.id);
    expect([refused.status, code(refused.body)]).toEqual([422, 'NO_CONTEXT_REFERENCE_EVIDENCE']);
    const message: string = refused.body.error.message;
    expect(message).toMatch(/declared no track/);
    // the remedy must be one that works: tracks are fixed at submission, so it names void-and-resubmit, not "declare a track later"
    expect(message).toMatch(/void this submission and submit it again/);
    expect(message).not.toMatch(/\(or declare a track\)/);
    expect(
      (await db.select().from(analysisRuns)).filter(
        (run) =>
          run.projectId === without.body.project.id && run.runType !== 'project_source_capture',
      ),
    ).toEqual([]);

    const withTrack = await submit(eventId, { ...pair(), trackKeys: ['health'] });
    expect(withTrack.status).toBe(201);
    expect(await declared(withTrack.body.project.id)).toEqual(['health']);
    expect((await requestAssessment(withTrack.body.project.id)).status).toBe(202);
  });

  it('several tracks are declared together, in any order, and the order does not change the submission’s identity', async () => {
    const { eventId } = await event({ ...NO_RULES, trackKeys: ['health', 'climate', 'edu'] });
    const body = pair();
    const key = randomUUID();
    const first = await submit(eventId, { ...body, trackKeys: ['health', 'edu'] }, { key });
    expect(first.status).toBe(201);
    expect(await declared(first.body.project.id)).toEqual(['edu', 'health']);
    const replay = await submit(eventId, { ...body, trackKeys: ['edu', 'health'] }, { key });
    expect([replay.status, replay.body.result]).toEqual([200, 'replayed']);
    expect(await declared(first.body.project.id)).toEqual(['edu', 'health']);
    // one audit event per declared track
    const audits = (await db.select().from(auditEvents)).filter(
      (row) => row.entityId === first.body.project.id && row.action === 'project_track_declared',
    );
    expect(audits).toHaveLength(2);
  });

  it('an unknown track is refused (UNKNOWN_TRACK) and not one row is written; malformed and repeated keys are 400', async () => {
    const { eventId } = await event({ trackKeys: ['health'] });
    const before = await rowsFor(eventId);
    const unknown = await submit(eventId, { ...pair(), trackKeys: ['health', 'web3'] });
    expect([unknown.status, code(unknown.body)]).toEqual([422, 'UNKNOWN_TRACK']);
    expect(ApiErrorBody.parse(unknown.body).error.details).toEqual({ unknownTrackKeys: ['web3'] });
    expect(await rowsFor(eventId)).toEqual(before);
    for (const bad of [['Not A Key'], ['health', 'health'], [''], 'health', [1]]) {
      const refused = await submit(eventId, { ...pair(), trackKeys: bad });
      expect(refused.status, JSON.stringify(bad)).toBe(400);
    }
    expect(await rowsFor(eventId)).toEqual(before);
  });

  it('a track of ANOTHER event is not accepted even though it exists (keys are validated against THIS event’s locked context)', async () => {
    const other = await event({ trackKeys: ['only_elsewhere'] });
    const { eventId } = await event({ trackKeys: ['health'] });
    const refused = await submit(eventId, { ...pair(), trackKeys: ['only_elsewhere'] });
    expect([refused.status, code(refused.body)]).toEqual([422, 'UNKNOWN_TRACK']);
    expect(other.eventId).not.toBe(eventId);
  });

  it('stale context: a selection made against an older locked version is refused, never applied to the new one', async () => {
    const { eventId, versionId } = await event({ trackKeys: ['health'] });
    const body = pair();
    const key = randomUUID();
    const good = await submit(
      eventId,
      { ...body, trackKeys: ['health'], contextVersionId: versionId },
      { key },
    );
    expect(good.status).toBe(201);
    // a new version is locked (the old one is superseded); the old form's token is now stale
    const relocked = await seedLockedContext(db, eventId, { trackKeys: ['health', 'climate'] });
    const before = await rowsFor(eventId);
    const stale = await submit(eventId, {
      ...pair(),
      trackKeys: ['health'],
      contextVersionId: versionId,
    });
    expect([stale.status, code(stale.body)]).toEqual([409, 'CONTEXT_VERSION_CHANGED']);
    expect(ApiErrorBody.parse(stale.body).error.details).toEqual({
      lockedContextVersionId: relocked.versionId,
    });
    expect(await rowsFor(eventId)).toEqual(before);
    // a retry of the ORIGINAL form after the change still replays: history is not rewritten and the retry is not punished
    const retry = await submit(
      eventId,
      { ...body, trackKeys: ['health'], contextVersionId: versionId },
      { key },
    );
    expect([retry.status, retry.body.result]).toEqual([200, 'replayed']);
    // with the new token the same choice is accepted, against the NEW version
    const current = await submit(eventId, {
      ...pair(),
      trackKeys: ['health', 'climate'],
      contextVersionId: relocked.versionId,
    });
    expect(current.status).toBe(201);
    const [selection] = await db
      .select()
      .from(projectTrackSelections)
      .where(
        sql`${projectTrackSelections.projectId} = ${current.body.project.id} AND ${projectTrackSelections.trackKey} = 'health'`,
      );
    expect(selection?.contextVersionId).toBe(relocked.versionId);
  });

  it('a track removed by a new locked version is UNKNOWN_TRACK even without a context token', async () => {
    const { eventId } = await event({ trackKeys: ['health', 'legacy'] });
    await seedLockedContext(db, eventId, { trackKeys: ['health'] });
    const refused = await submit(eventId, { ...pair(), trackKeys: ['legacy'] });
    expect([refused.status, code(refused.body)]).toEqual([422, 'UNKNOWN_TRACK']);
  });

  it('retries: same key + same tracks replays; same key + other tracks is IDEMPOTENCY_KEY_REUSED; nothing is duplicated', async () => {
    const { eventId } = await event({ ...NO_RULES, trackKeys: ['health', 'climate'] });
    const body = pair();
    const key = randomUUID();
    const first = await submit(eventId, { ...body, trackKeys: ['health'] }, { key });
    expect(first.status).toBe(201);
    const again = await submit(eventId, { ...body, trackKeys: ['health'] }, { key });
    expect([again.status, again.body.result]).toEqual([200, 'replayed']);
    const other = await submit(eventId, { ...body, trackKeys: ['climate'] }, { key });
    expect([other.status, code(other.body)]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
    expect(await declared(first.body.project.id)).toEqual(['health']);
    expect((await rowsFor(eventId)).projects).toBe(1);
  });

  it('convergence: the identical pair with the same tracks converges; with DIFFERENT tracks it is a conflict that changes nothing', async () => {
    const { eventId } = await event({ ...NO_RULES, trackKeys: ['health', 'climate'] });
    const body = pair();
    const first = await submit(eventId, { ...body, trackKeys: ['health'] });
    const same = await submit(eventId, { ...body, trackKeys: ['health'] });
    expect([same.status, same.body.result, same.body.project.id]).toEqual([
      200,
      'already_submitted',
      first.body.project.id,
    ]);
    const before = await rowsFor(eventId);
    const differ = await submit(eventId, { ...body, trackKeys: ['climate'] });
    expect([differ.status, code(differ.body)]).toEqual([409, 'SUBMISSION_CONFLICT']);
    expect(ApiErrorBody.parse(differ.body).error.details).toMatchObject({
      reason: 'tracks_differ',
      declaredTrackKeys: ['health'],
    });
    expect(await rowsFor(eventId)).toEqual(before);
    expect(await declared(first.body.project.id)).toEqual(['health']);
    // a client that states nothing about tracks (the older form) keeps converging as before
    const legacy = await submit(eventId, body);
    expect([legacy.status, legacy.body.result]).toEqual([200, 'already_submitted']);
  });

  it('ownership uniqueness and authorization are unchanged: links stay exclusive per event; no token is 401; a user without a role is 403', async () => {
    const { eventId } = await event({ ...NO_RULES, trackKeys: ['health'] });
    const body = pair();
    expect((await submit(eventId, { ...body, trackKeys: ['health'] })).status).toBe(201);
    const shared = await submit(eventId, {
      githubUrl: body.githubUrl,
      devpostUrl: dp(`x-${unique()}`),
      trackKeys: ['health'],
    });
    expect([shared.status, code(shared.body)]).toEqual([409, 'SUBMISSION_CONFLICT']);
    expect(
      (await submit(eventId, { ...pair(), trackKeys: ['health'] }, { token: null })).status,
    ).toBe(401);
    expect(
      (await submit(eventId, { ...pair(), trackKeys: ['health'] }, { token: TEST_TOKENS.noRole }))
        .status,
    ).toBe(403);
    const unauthorised = (await db.select().from(projects)).filter((p) => p.eventId === eventId);
    expect(unauthorised).toHaveLength(1);
  });

  it('correction: void-and-replace carries the corrected tracks, and the voided project keeps its original declarations', async () => {
    const { eventId } = await event({ ...NO_RULES, trackKeys: ['health', 'climate'] });
    const wrong = await submit(eventId, { ...pair(), trackKeys: ['health'] });
    const fixed = pair();
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${wrong.body.project.id}/void`,
      headers: { ...bearer(TEST_TOKENS.organizer), 'idempotency-key': randomUUID() },
      payload: {
        reason: 'Wrong track and links.',
        cancelPendingWork: true,
        replacement: { ...fixed, trackKeys: ['climate'] },
      },
    });
    expect(response.statusCode).toBe(201);
    const replacementId = response.json<Reply>().replacement.project.id;
    expect(await declared(replacementId)).toEqual(['climate']);
    expect(await declared(wrong.body.project.id)).toEqual(['health']);
  });

  it('the project’s sources report the latest USABLE capture, which stays when a newer attempt fails (the capture page and the report use it)', async () => {
    const { eventId } = await event({ trackKeys: ['health'] });
    const created = await submit(eventId, pair());
    const projectId = created.body.project.id;
    const [source] = (await db.select().from(projectSources)).filter(
      (row) => row.projectId === projectId && row.sourceType === 'devpost',
    );
    if (!source) throw new Error('no source');
    const good = await seedLaterCapture(db, { id: projectId }, source, 'captured', [
      {
        key: 'submission.txt',
        kind: 'submission_text',
        mediaType: 'text/plain',
        text: 'A synthetic submission text that is long enough to be a statement.',
      },
    ]);
    await seedLaterCapture(db, { id: projectId }, source, 'failed');
    const detail = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}`,
      headers: bearer(TEST_TOKENS.organizer),
    });
    const { sources } = detail.json<Reply>();
    const record = sources.find((row) => row.id === source.id);
    expect(record?.latestSnapshot?.status).toBe('failed');
    expect(record?.latestUsableSnapshot).toMatchObject({ id: good.id, status: 'captured' });
    // a source whose only attempts are pending or failed has no usable capture
    const other = sources.find((row) => row.sourceType === 'github');
    expect(other?.latestUsableSnapshot).toBeNull();
  });

  it('track-scoped rubric: the overall rubric is what is assessed and the context’s track rubric does not substitute for a missing overall one', async () => {
    const withBoth = await event({
      ...NO_RULES,
      trackKeys: ['health'],
      trackRubricKeys: ['health'],
    });
    const a = await submit(withBoth.eventId, { ...pair(), trackKeys: ['health'] });
    expect((await requestAssessment(a.body.project.id)).status).toBe(202);
    const trackRubricOnly = await event({
      trackKeys: ['health'],
      trackRubricKeys: ['health'],
      noRubric: true,
    });
    const b = await submit(trackRubricOnly.eventId, { ...pair(), trackKeys: ['health'] });
    const refused = await requestAssessment(b.body.project.id);
    expect([refused.status, code(refused.body)]).toEqual([422, 'NO_OVERALL_RUBRIC']);
    expect(refused.body.error.message).toMatch(/track rubrics are not assessed/);
    expect(refused.body.error.message).toMatch(/Nothing was queued or spent/);
  });
});
