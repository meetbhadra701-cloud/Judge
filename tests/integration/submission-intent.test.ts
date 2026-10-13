import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { ApiErrorBody } from '../../packages/schemas/src/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actors,
  analysisRuns,
  assessmentRequests,
  auditEvents,
  projectSources,
  projectSubmissionRequests,
  projectSubmissions,
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

/*
 * P6B-beta1 (R7-1 / R7-2): the submission operation `POST /events/:eventId/submissions`.
 *
 * Every test checks the PERSISTED rows (projects, declared sources, submission records, idempotency records, snapshots, runs), never a
 * response alone. The concurrency tests fire requests at the real routes on separate connections where the target is PostgreSQL (the
 * PGlite target serializes statements but still interleaves the separate transactions of separate requests). The shape of every
 * assertion is "no matter who wins, the stored state is one coherent submission per intent".
 */

const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
const ROUNDS = 8;
let counter = 0;
const unique = (): string => (counter += 1).toString(36);

function code(body: unknown): string {
  return ApiErrorBody.parse(body).error.code;
}

const gh = (name: string) => `https://github.com/synthetic/${name}`;
const dp = (name: string) => `https://devpost.com/software/${name}`;

describe.each(testDatabaseTargets())('submission intents on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;
  let app: ApiApp;
  let eventContext: EventContextService;
  let service: ProjectService;

  beforeAll(async () => {
    testDb = await open();
    db = testDb.db;
    const fixtures = await loadFixtures();
    eventContext = replayService(db, fixtures.values());
    service = new ProjectService({ db });
    app = buildApp({
      logger,
      db,
      verifier: fakeVerifier(),
      eventContext,
      projects: service,
      assessments: new AssessmentService({ db, offline: null }),
    });
  });
  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  async function lockedEvent(): Promise<string> {
    const fixtures = await loadFixtures();
    const { eventId } = await lockedEventFromRecording(
      eventContext,
      requireValue(fixtures.get('fixture-e-multiple-tracks')),
    );
    return eventId;
  }

  interface SubmitArgs {
    eventId: string;
    github: string;
    devpost: string;
    name?: string | null;
    key?: string | null;
    token?: string;
    extraBody?: Record<string, unknown>;
  }
  async function submit(args: SubmitArgs) {
    const key = args.key === undefined ? randomUUID() : args.key;
    const response = await app.inject({
      method: 'POST',
      url: `/events/${args.eventId}/submissions`,
      headers: {
        ...bearer(args.token ?? TEST_TOKENS.organizer),
        ...(key === null ? {} : { 'idempotency-key': key }),
      },
      payload: {
        githubUrl: args.github,
        devpostUrl: args.devpost,
        ...(args.name === undefined ? {} : { name: args.name }),
        ...args.extraBody,
      },
    });
    return { status: response.statusCode, body: response.json<Record<string, unknown>>(), key };
  }

  async function state(eventId: string) {
    const projectRows = await db.select().from(projects);
    const mine = projectRows.filter((row) => row.eventId === eventId);
    const ids = new Set(mine.map((row) => row.id));
    const sources = (await db.select().from(projectSources)).filter((row) =>
      ids.has(row.projectId),
    );
    const submissions = (await db.select().from(projectSubmissions)).filter(
      (row) => row.eventId === eventId,
    );
    const requests = (await db.select().from(projectSubmissionRequests)).filter((row) =>
      ids.has(row.projectId),
    );
    const snapshots = (await db.select().from(sourceSnapshots)).filter((row) =>
      ids.has(row.projectId),
    );
    const runs = (await db.select().from(analysisRuns)).filter(
      (row) => row.projectId !== null && ids.has(row.projectId),
    );
    return { projects: mine, sources, submissions, requests, snapshots, runs };
  }

  /** A project's declared links, from the stored rows. */
  function linksOf(rows: Awaited<ReturnType<typeof state>>, projectId: string) {
    const sources = rows.sources.filter((row) => row.projectId === projectId);
    return {
      github: sources.filter((row) => row.sourceType === 'github').map((row) => row.url),
      devpost: sources.filter((row) => row.sourceType === 'devpost').map((row) => row.url),
    };
  }

  async function totals() {
    return {
      projects: (await db.select().from(projects)).length,
      sources: (await db.select().from(projectSources)).length,
      submissions: (await db.select().from(projectSubmissions)).length,
      requests: (await db.select().from(projectSubmissionRequests)).length,
      snapshots: (await db.select().from(sourceSnapshots)).length,
      runs: (await db.select().from(analysisRuns)).length,
      audit: (await db.select().from(auditEvents)).length,
    };
  }

  // -- the contract ----------------------------------------------------------------------------------------------------------

  it('creates the project, both declarations, both capture requests and the records in one operation, and nothing else', async () => {
    const eventId = await lockedEvent();
    const assessmentsBefore = (await db.select().from(assessmentRequests)).length;
    const name = unique();
    const response = await submit({
      eventId,
      github: `HTTPS://GitHub.com/Synthetic/Atlas-${name}.git`,
      devpost: `${dp(`atlas-${name}`)}/`,
    });
    expect(response.status).toBe(201);
    expect(response.body['result']).toBe('created');
    const rows = await state(eventId);
    expect(rows.projects).toHaveLength(1);
    const project = requireValue(rows.projects[0]);
    expect(project.name).toBe(`synthetic/atlas-${name}`);
    expect(rows.sources.map((row) => [row.sourceType, row.url, row.position])).toEqual([
      ['github', gh(`atlas-${name}`), 0],
      ['devpost', dp(`atlas-${name}`), 1],
    ]);
    expect(rows.submissions).toHaveLength(1);
    expect(rows.requests.map((row) => row.result)).toEqual(['created']);
    expect(rows.snapshots.map((row) => row.status).sort()).toEqual(['pending', 'pending']);
    expect(rows.runs.map((row) => [row.runType, row.state])).toEqual([
      ['project_source_capture', 'pending'],
      ['project_source_capture', 'pending'],
    ]);
    const captureRuns = response.body['captureRuns'] as { runId: string }[];
    expect(captureRuns.map((run) => run.runId).sort()).toEqual(
      rows.runs.map((run) => run.id).sort(),
    );
    expect((await db.select().from(assessmentRequests)).length).toBe(assessmentsBefore);
  });

  it('replays the same Idempotency-Key with the same content: the original project, nothing written or requested twice', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const first = await submit({
      eventId,
      github: gh(`replay-${n}`),
      devpost: dp(`replay-${n}`),
      name: 'Replay Team',
    });
    const before = await totals();
    const again = await submit({
      eventId,
      github: gh(`replay-${n}`),
      devpost: dp(`replay-${n}`),
      name: 'Replay Team',
      key: first.key,
    });
    expect(again.status).toBe(200);
    expect(again.body['result']).toBe('replayed');
    expect((again.body['project'] as { id: string }).id).toBe(
      (first.body['project'] as { id: string }).id,
    );
    expect(again.body['captureRuns']).toEqual([]);
    expect(await totals()).toEqual(before);
  });

  it('is case-insensitive about the key and about URL spelling', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const first = await submit({ eventId, github: gh(`spell-${n}`), devpost: dp(`spell-${n}`) });
    const before = await totals();
    const again = await submit({
      eventId,
      github: `https://www.github.com/SYNTHETIC/Spell-${n}/`,
      devpost: `https://WWW.devpost.com/software/Spell-${n}`,
      key: (first.key ?? '').toUpperCase(),
    });
    expect([again.status, again.body['result']]).toEqual([200, 'replayed']);
    expect(await totals()).toEqual(before);
  });

  it('refuses the same key with different content, and writes nothing', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const first = await submit({ eventId, github: gh(`reuse-${n}`), devpost: dp(`reuse-${n}`) });
    const before = await totals();
    const variants: Pick<SubmitArgs, 'github' | 'devpost' | 'name'>[] = [
      { github: gh(`reuse-${n}`), devpost: dp(`other-${n}`) },
      { github: gh(`other-${n}`), devpost: dp(`reuse-${n}`) },
      { github: gh(`reuse-${n}`), devpost: dp(`reuse-${n}`), name: 'A different label' },
    ];
    for (const variant of variants) {
      const reused = await submit({ eventId, ...variant, key: first.key });
      expect([reused.status, code(reused.body)]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
    }
    expect(await totals()).toEqual(before);
  });

  it('refuses the same key against another event', async () => {
    const eventA = await lockedEvent();
    const eventB = await lockedEvent();
    const n = unique();
    const first = await submit({
      eventId: eventA,
      github: gh(`cross-${n}`),
      devpost: dp(`cross-${n}`),
    });
    const before = await totals();
    const reused = await submit({
      eventId: eventB,
      github: gh(`cross-${n}`),
      devpost: dp(`cross-${n}`),
      key: first.key,
    });
    expect([reused.status, code(reused.body)]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
    expect(await totals()).toEqual(before);
    expect((await state(eventB)).projects).toHaveLength(0);
  });

  it('lets the same links be submitted to a different event as an independent project', async () => {
    const eventA = await lockedEvent();
    const eventB = await lockedEvent();
    const n = unique();
    const a = await submit({
      eventId: eventA,
      github: gh(`shared-${n}`),
      devpost: dp(`shared-${n}`),
    });
    const b = await submit({
      eventId: eventB,
      github: gh(`shared-${n}`),
      devpost: dp(`shared-${n}`),
    });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect((a.body['project'] as { id: string }).id).not.toBe(
      (b.body['project'] as { id: string }).id,
    );
    expect((await state(eventA)).projects).toHaveLength(1);
    expect((await state(eventB)).projects).toHaveLength(1);
  });

  it('converges an identical GitHub + Devpost pair sent with a different key on the SAME project (proven-equivalent content)', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const first = await submit({ eventId, github: gh(`same-${n}`), devpost: dp(`same-${n}`) });
    const before = await totals();
    const second = await submit({
      eventId,
      github: gh(`same-${n}`),
      devpost: dp(`same-${n}`),
      name: 'Another label',
    });
    expect([second.status, second.body['result']]).toEqual([200, 'already_submitted']);
    const project = second.body['project'] as { id: string; name: string };
    expect(project.id).toBe((first.body['project'] as { id: string }).id);
    expect(project.name).toBe(`synthetic/same-${n}`); // the existing label is reported, not overwritten
    expect(second.body['captureRuns']).toEqual([]);
    const after = await totals();
    expect({ ...after, requests: after.requests - 1, audit: 0 }).toEqual({ ...before, audit: 0 }); // only the new key is recorded
    // that second key is now pinned to ITS content too
    const reused = await submit({
      eventId,
      github: gh(`same-${n}`),
      devpost: dp(`different-${n}`),
      key: second.key,
    });
    expect([reused.status, code(reused.body)]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
  });

  it('converges the same pair submitted by a different actor, and records who submitted it', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const first = await submit({ eventId, github: gh(`actors-${n}`), devpost: dp(`actors-${n}`) });
    const second = await submit({
      eventId,
      github: gh(`actors-${n}`),
      devpost: dp(`actors-${n}`),
      token: TEST_TOKENS.secondOrganizer,
    });
    expect([second.status, second.body['result']]).toEqual([200, 'already_submitted']);
    const rows = await state(eventId);
    expect(rows.projects).toHaveLength(1);
    expect(new Set(rows.requests.map((row) => row.actorId)).size).toBe(2);
    expect((first.body['project'] as { id: string }).id).toBe(
      (second.body['project'] as { id: string }).id,
    );
  });

  it('refuses a submission that shares only ONE link with another submission, whoever sends it, and writes nothing', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const first = await submit({
      eventId,
      github: gh(`overlap-${n}`),
      devpost: dp(`overlap-${n}`),
    });
    const firstId = (first.body['project'] as { id: string }).id;
    const before = await totals();
    for (const token of [TEST_TOKENS.organizer, TEST_TOKENS.secondOrganizer]) {
      const sameGithub = await submit({
        eventId,
        github: gh(`overlap-${n}`),
        devpost: dp(`new-${n}`),
        token,
      });
      expect([sameGithub.status, code(sameGithub.body)]).toEqual([409, 'SUBMISSION_CONFLICT']);
      expect(ApiErrorBody.parse(sameGithub.body).error.details).toEqual({ projectIds: [firstId] });
      const sameDevpost = await submit({
        eventId,
        github: gh(`new-${n}`),
        devpost: dp(`overlap-${n}`),
        token,
      });
      expect([sameDevpost.status, code(sameDevpost.body)]).toEqual([409, 'SUBMISSION_CONFLICT']);
    }
    expect(await totals()).toEqual(before);
    const rows = await state(eventId);
    expect(linksOf(rows, firstId)).toEqual({
      github: [gh(`overlap-${n}`)],
      devpost: [dp(`overlap-${n}`)],
    });
  });

  it('refuses names that differ only by letter case, and never adopts the other project', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const first = await submit({
      eventId,
      github: gh(`case-a-${n}`),
      devpost: dp(`case-a-${n}`),
      name: `Team ${n}`,
    });
    const before = await totals();
    for (const variant of [`team ${n}`, `TEAM ${n}`, `  Team ${n}  `, `Team ${n}`]) {
      const clash = await submit({
        eventId,
        github: gh(`case-b-${n}`),
        devpost: dp(`case-b-${n}`),
        name: variant,
      });
      expect([clash.status, code(clash.body)]).toEqual([409, 'PROJECT_NAME_TAKEN']);
    }
    expect(await totals()).toEqual(before);
    // an earlier-flow project with a colliding name is not adopted either
    const legacy = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/projects`,
      headers: bearer(TEST_TOKENS.organizer),
      payload: { name: `Legacy ${n}` },
    });
    const legacyId = legacy.json<{ id: string }>().id;
    const collide = await submit({
      eventId,
      github: gh(`case-c-${n}`),
      devpost: dp(`case-c-${n}`),
      name: `LEGACY ${n}`,
    });
    expect([collide.status, code(collide.body)]).toEqual([409, 'PROJECT_NAME_TAKEN']);
    const rows = await state(eventId);
    expect(rows.sources.filter((row) => row.projectId === legacyId)).toHaveLength(0);
    expect(rows.projects.map((row) => row.id)).toContain(
      (first.body['project'] as { id: string }).id,
    );
  });

  it('refuses a link already declared by an earlier-flow project, instead of adopting or duplicating it', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const legacy = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/projects`,
      headers: bearer(TEST_TOKENS.organizer),
      payload: { name: `Old ${n}` },
    });
    const legacyId = legacy.json<{ id: string }>().id;
    await app.inject({
      method: 'POST',
      url: `/projects/${legacyId}/sources`,
      headers: bearer(TEST_TOKENS.organizer),
      payload: { sourceType: 'github', url: gh(`old-${n}`) },
    });
    const before = await totals();
    const clash = await submit({ eventId, github: gh(`old-${n}`), devpost: dp(`old-${n}`) });
    expect([clash.status, code(clash.body)]).toEqual([409, 'SUBMISSION_CONFLICT']);
    expect(ApiErrorBody.parse(clash.body).error.details).toEqual({ projectIds: [legacyId] });
    expect(await totals()).toEqual(before);
  });

  it('an earlier-flow project that mixes several links does not block the correct submission of its links, and stays flagged', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const post = (url: string, payload: unknown) =>
      app.inject({
        method: 'POST',
        url,
        headers: bearer(TEST_TOKENS.organizer),
        payload: payload as object,
      });
    const mixed = (await post(`/events/${eventId}/projects`, { name: `Old mixed ${n}` })).json<{
      id: string;
    }>().id;
    await post(`/projects/${mixed}/sources`, { sourceType: 'github', url: gh(`remedy-${n}`) });
    await post(`/projects/${mixed}/sources`, { sourceType: 'devpost', url: dp(`remedy-${n}-a`) });
    await post(`/projects/${mixed}/sources`, { sourceType: 'devpost', url: dp(`remedy-${n}-b`) });
    const before = await totals();
    // the correct intent (repository + the first Devpost page) is accepted as a NEW project; nothing about the mixed one is rewritten
    const fixed = await submit({
      eventId,
      github: gh(`remedy-${n}`),
      devpost: dp(`remedy-${n}-a`),
    });
    expect(fixed.status).toBe(201);
    const after = await state(eventId);
    expect(after.projects).toHaveLength(2);
    expect(linksOf(after, mixed)).toEqual({
      github: [gh(`remedy-${n}`)],
      devpost: [dp(`remedy-${n}-a`), dp(`remedy-${n}-b`)],
    });
    const fixedId = (fixed.body['project'] as { id: string }).id;
    expect(linksOf(after, fixedId)).toEqual({
      github: [gh(`remedy-${n}`)],
      devpost: [dp(`remedy-${n}-a`)],
    });
    expect((await totals()).projects).toBe(before.projects + 1);
    // the mixed project is still reported, and now so is the link both projects hold
    const report = (
      await app.inject({
        method: 'GET',
        url: `/events/${eventId}/submission-integrity`,
        headers: bearer(TEST_TOKENS.organizer),
      })
    ).json<{
      findings: { kind: string; sourceType: string; projectIds: string[] }[];
    }>();
    expect(
      report.findings
        .filter((f) => f.projectIds.includes(mixed))
        .map((f) => f.kind)
        .sort(),
    ).toEqual(['multiple_sources_of_one_type', 'shared_source_url', 'shared_source_url']); // the repository and the first Devpost page are each held by both
    // a second, DIFFERENT submission of the same repository is still refused (it now conflicts with the clean one)
    const clash = await submit({
      eventId,
      github: gh(`remedy-${n}`),
      devpost: dp(`remedy-${n}-b`),
    });
    expect([clash.status, code(clash.body)]).toEqual([409, 'SUBMISSION_CONFLICT']);
    expect(ApiErrorBody.parse(clash.body).error.details).toEqual({ projectIds: [fixedId] });
  });

  // -- concurrency (separate requests, separate transactions; separate connections on PostgreSQL) ---------------------------

  it('R7-1: two simultaneous submissions that share a GitHub repository but differ in Devpost never share a project', async () => {
    const eventId = await lockedEvent();
    for (let round = 0; round < ROUNDS; round += 1) {
      const n = unique();
      const results = await Promise.all([
        submit({ eventId, github: gh(`race-g-${n}`), devpost: dp(`race-g-${n}-a`) }),
        submit({ eventId, github: gh(`race-g-${n}`), devpost: dp(`race-g-${n}-b`) }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const loser = requireValue(results.find((r) => r.status === 409));
      expect(code(loser.body)).toBe('SUBMISSION_CONFLICT');
      const rows = await state(eventId);
      const owners = rows.sources.filter((row) => row.url === gh(`race-g-${n}`));
      expect(owners).toHaveLength(1);
      const winnerLinks = linksOf(rows, requireValue(owners[0]).projectId);
      expect(winnerLinks.github).toHaveLength(1);
      expect(winnerLinks.devpost).toHaveLength(1);
      // the loser's Devpost link exists nowhere
      const devposts = rows.sources.filter((row) => row.url.startsWith(dp(`race-g-${n}`)));
      expect(devposts).toHaveLength(1);
    }
  });

  it('two simultaneous submissions that share a Devpost page but differ in GitHub never share a project', async () => {
    const eventId = await lockedEvent();
    for (let round = 0; round < ROUNDS; round += 1) {
      const n = unique();
      const results = await Promise.all([
        submit({ eventId, github: gh(`race-d-${n}-a`), devpost: dp(`race-d-${n}`) }),
        submit({ eventId, github: gh(`race-d-${n}-b`), devpost: dp(`race-d-${n}`) }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const rows = await state(eventId);
      expect(rows.sources.filter((row) => row.url === dp(`race-d-${n}`))).toHaveLength(1);
      expect(rows.sources.filter((row) => row.url.startsWith(gh(`race-d-${n}`)))).toHaveLength(1);
    }
  });

  it('two simultaneous submissions with the same typed name (or names differing only by case) create at most one project per label', async () => {
    const eventId = await lockedEvent();
    for (let round = 0; round < ROUNDS; round += 1) {
      const n = unique();
      const results = await Promise.all([
        submit({
          eventId,
          github: gh(`race-n-${n}-a`),
          devpost: dp(`race-n-${n}-a`),
          name: `Atlas ${n}`,
        }),
        submit({
          eventId,
          github: gh(`race-n-${n}-b`),
          devpost: dp(`race-n-${n}-b`),
          name: `ATLAS ${n}`,
        }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(code(requireValue(results.find((r) => r.status === 409)).body)).toBe(
        'PROJECT_NAME_TAKEN',
      );
      const rows = await state(eventId);
      expect(rows.projects.filter((row) => row.name.toLowerCase() === `atlas ${n}`)).toHaveLength(
        1,
      );
      // the loser left nothing behind: every stored project has exactly one github and one devpost source
      for (const project of rows.projects) {
        const links = linksOf(rows, project.id);
        expect([links.github.length, links.devpost.length]).toEqual([1, 1]);
      }
    }
  });

  it('concurrent retries of ONE submission (same key) create exactly one project and one capture pair', async () => {
    const eventId = await lockedEvent();
    for (let round = 0; round < ROUNDS; round += 1) {
      const n = unique();
      const key = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          submit({ eventId, github: gh(`retry-${n}`), devpost: dp(`retry-${n}`), key }),
        ),
      );
      expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
      expect(results.filter((r) => r.body['result'] === 'created')).toHaveLength(1);
      expect(new Set(results.map((r) => (r.body['project'] as { id: string }).id)).size).toBe(1);
      const rows = await state(eventId);
      const mine = rows.sources.filter((row) => row.url.endsWith(`retry-${n}`));
      expect(mine).toHaveLength(2);
      expect(
        rows.snapshots.filter((s) => mine.some((m) => m.id === s.projectSourceId)),
      ).toHaveLength(2);
      expect(rows.requests.filter((r) => r.idempotencyKey === key)).toHaveLength(1);
    }
  });

  it('concurrent submissions of an identical pair with DIFFERENT keys converge on one project', async () => {
    const eventId = await lockedEvent();
    for (let round = 0; round < ROUNDS; round += 1) {
      const n = unique();
      const results = await Promise.all(
        [TEST_TOKENS.organizer, TEST_TOKENS.secondOrganizer, TEST_TOKENS.organizer].map((token) =>
          submit({ eventId, github: gh(`conv-${n}`), devpost: dp(`conv-${n}`), token }),
        ),
      );
      expect(results.filter((r) => r.body['result'] === 'created')).toHaveLength(1);
      expect(results.filter((r) => r.body['result'] === 'already_submitted')).toHaveLength(2);
      expect(new Set(results.map((r) => (r.body['project'] as { id: string }).id)).size).toBe(1);
      const rows = await state(eventId);
      expect(rows.sources.filter((row) => row.url.endsWith(`conv-${n}`))).toHaveLength(2);
    }
  });

  it('a key used concurrently for two DIFFERENT submissions is accepted for exactly one of them', async () => {
    const eventId = await lockedEvent();
    for (let round = 0; round < ROUNDS; round += 1) {
      const n = unique();
      const key = randomUUID();
      const results = await Promise.all([
        submit({ eventId, github: gh(`key-${n}-a`), devpost: dp(`key-${n}-a`), key }),
        submit({ eventId, github: gh(`key-${n}-b`), devpost: dp(`key-${n}-b`), key }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
      expect(code(requireValue(results.find((r) => r.status === 422)).body)).toBe(
        'IDEMPOTENCY_KEY_REUSED',
      );
      const rows = await state(eventId);
      expect(rows.sources.filter((row) => row.url.includes(`key-${n}-`))).toHaveLength(2);
    }
  });

  it('many simultaneous submissions of distinct intents all succeed independently (no false conflicts)', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        submit({
          eventId,
          github: gh(`many-${n}-${String(i)}`),
          devpost: dp(`many-${n}-${String(i)}`),
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
    const rows = await state(eventId);
    expect(rows.projects).toHaveLength(6);
    for (const project of rows.projects) {
      const links = linksOf(rows, project.id);
      expect([links.github.length, links.devpost.length]).toEqual([1, 1]);
      expect(links.github[0]?.split('-').at(-1)).toBe(links.devpost[0]?.split('-').at(-1));
    }
  });

  // -- atomicity and recovery --------------------------------------------------------------------------------------------------

  it('a failure at ANY point of the operation leaves nothing behind, and the retry then succeeds exactly once', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const key = randomUUID();
    const body = { githubUrl: gh(`atomic-${n}`), devpostUrl: dp(`atomic-${n}`) };
    let failuresAt = 0;
    for (let failAt = 1; ; failAt += 1) {
      let calls = 0;
      const flaky = new ProjectService({
        db,
        newId: () => {
          calls += 1;
          if (calls === failAt) throw new Error('injected failure');
          return randomUUID();
        },
      });
      const before = await totals();
      let outcome: 'failed' | 'ok';
      try {
        await flaky.submitProject(eventId, body, await actorId(), key);
        outcome = 'ok';
      } catch (error) {
        expect((error as Error).message).toBe('injected failure');
        outcome = 'failed';
      }
      if (outcome === 'ok') break;
      failuresAt += 1;
      expect(await totals()).toEqual(before); // nothing partial: no project, no source, no record, no capture, no audit row
      expect(failAt).toBeLessThan(60);
    }
    expect(failuresAt).toBeGreaterThan(8); // the sweep really crossed project, submission, request, both sources and both captures
    const rows = await state(eventId);
    expect(rows.projects).toHaveLength(1);
    expect(rows.sources).toHaveLength(2);
    expect(rows.snapshots).toHaveLength(2);
    // the healthy retry with the same key replays instead of creating again
    const retry = await submit({ eventId, github: body.githubUrl, devpost: body.devpostUrl, key });
    expect([retry.status, retry.body['result']]).toEqual([200, 'replayed']);
    expect((await state(eventId)).projects).toHaveLength(1);
  });

  async function actorId(): Promise<string> {
    await app.inject({ method: 'GET', url: '/events', headers: bearer(TEST_TOKENS.organizer) }); // resolves (and stores) the actor
    const [row] = (await db.select().from(actors)).filter(
      (actor) => actor.subject === 'organizer-1',
    );
    return requireValue(row).id;
  }

  // -- the database is the backstop --------------------------------------------------------------------------------------------

  it('a project of a submission cannot gain a different GitHub or Devpost source through the route or direct SQL; other source types still work', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const created = await submit({ eventId, github: gh(`fixed-${n}`), devpost: dp(`fixed-${n}`) });
    const projectId = (created.body['project'] as { id: string }).id;
    const add = (sourceType: string, url: string) =>
      app.inject({
        method: 'POST',
        url: `/projects/${projectId}/sources`,
        headers: bearer(TEST_TOKENS.organizer),
        payload: { sourceType, url },
      });
    const other = await add('devpost', dp(`other-${n}`));
    expect([other.statusCode, code(other.json())]).toEqual([409, 'SUBMISSION_SOURCE_FIXED']);
    const otherGithub = await add('github', gh(`other-${n}`));
    expect([otherGithub.statusCode, code(otherGithub.json())]).toEqual([
      409,
      'SUBMISSION_SOURCE_FIXED',
    ]);
    const same = await add('github', gh(`fixed-${n}`));
    expect([same.statusCode, code(same.json())]).toEqual([409, 'DUPLICATE_SOURCE']);
    const video = await add('video', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(video.statusCode).toBe(201);
    // direct SQL cannot bypass the route check
    await expect(
      db.insert(projectSources).values({
        id: randomUUID(),
        projectId,
        sourceType: 'devpost',
        url: dp(`sql-${n}`),
        position: 9,
      }),
    ).rejects.toThrow();
    const rows = await state(eventId);
    expect(linksOf(rows, projectId)).toEqual({
      github: [gh(`fixed-${n}`)],
      devpost: [dp(`fixed-${n}`)],
    });
  });

  it('submission records are append-only and unique per link, even for direct SQL', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    await submit({ eventId, github: gh(`sql-${n}`), devpost: dp(`sql-${n}`) });
    const [row] = (await db.select().from(projectSubmissions)).filter(
      (r) => r.githubUrl === gh(`sql-${n}`),
    );
    const submission = requireValue(row);
    await expect(db.delete(projectSubmissions)).rejects.toThrow();
    await expect(
      db.update(projectSubmissions).set({ githubUrl: gh(`moved-${n}`) }),
    ).rejects.toThrow();
    await expect(db.delete(projectSubmissionRequests)).rejects.toThrow();
    await expect(
      db
        .update(projectSubmissionRequests)
        .set({ requestHash: createHash('sha256').update('x').digest('hex') }),
    ).rejects.toThrow();
    // a second submission over the same event + link is refused by the unique constraint, not by application code
    const extra = await db
      .insert(projects)
      .values({ id: randomUUID(), eventId, name: `sql-extra-${n}` })
      .returning();
    await expect(
      db.insert(projectSubmissions).values({
        id: randomUUID(),
        eventId,
        projectId: requireValue(extra[0]).id,
        submittedByActorId: submission.submittedByActorId,
        githubUrl: submission.githubUrl,
        devpostUrl: dp(`sql-extra-${n}`),
        nameKey: `sql-extra-${n}`,
      }),
    ).rejects.toThrow();
  });

  // -- validation, authorization, isolation ----------------------------------------------------------------------------------

  it('rejects bad input before writing anything', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const open = await app.inject({
      method: 'POST',
      url: '/events',
      headers: bearer(TEST_TOKENS.organizer),
      payload: { name: 'Open', slug: `open-${n}` },
    });
    const before = await totals();
    const missingKey = await submit({ eventId, github: gh(n), devpost: dp(n), key: null });
    expect(missingKey.status).toBe(400);
    const badKey = await submit({ eventId, github: gh(n), devpost: dp(n), key: 'not-a-uuid' });
    expect(badKey.status).toBe(400);
    const extra = await submit({
      eventId,
      github: gh(n),
      devpost: dp(n),
      extraBody: { projectId: randomUUID() },
    });
    expect(extra.status).toBe(400);
    const badGithub = await submit({
      eventId,
      github: 'https://github.com/synthetic/atlas/tree/main',
      devpost: dp(n),
    });
    expect([badGithub.status, code(badGithub.body)]).toEqual([422, 'INVALID_SOURCE_URL']);
    expect(ApiErrorBody.parse(badGithub.body).error.details).toMatchObject({
      field: 'github',
      reason: 'unsupported_path',
    });
    const swapped = await submit({ eventId, github: dp(n), devpost: gh(n) });
    expect(ApiErrorBody.parse(swapped.body).error.details).toMatchObject({
      field: 'github',
      reason: 'unsupported_host',
    });
    const unknownEvent = await submit({ eventId: randomUUID(), github: gh(n), devpost: dp(n) });
    expect([unknownEvent.status, code(unknownEvent.body)]).toEqual([404, 'EVENT_NOT_FOUND']);
    const unlocked = await submit({
      eventId: open.json<{ id: string }>().id,
      github: gh(n),
      devpost: dp(n),
    });
    expect([unlocked.status, code(unlocked.body)]).toEqual([409, 'NO_LOCKED_CONTEXT']);
    expect(await totals()).toEqual(before);
  });

  it('keeps authentication and authorization: judges, unprivileged and anonymous callers write nothing', async () => {
    const eventId = await lockedEvent();
    const before = await totals();
    const n = unique();
    const judge = await submit({
      eventId,
      github: gh(n),
      devpost: dp(n),
      token: TEST_TOKENS.judge,
    });
    expect([judge.status, code(judge.body)]).toEqual([403, 'FORBIDDEN']);
    const nobody = await submit({
      eventId,
      github: gh(n),
      devpost: dp(n),
      token: TEST_TOKENS.noRole,
    });
    expect(nobody.status).toBe(403);
    const anonymous = await app.inject({
      method: 'POST',
      url: `/events/${eventId}/submissions`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { githubUrl: gh(n), devpostUrl: dp(n) },
    });
    expect(anonymous.statusCode).toBe(401);
    expect(await totals()).toEqual(before);
  });

  // -- capture and worker retries keep every source with its own project -------------------------------------------------------

  it('worker captures and capture retries stay attached to the submission that requested them', async () => {
    const eventId = await lockedEvent();
    const good = await submit({
      eventId,
      github: 'https://github.com/synthetic/atlas',
      devpost: 'https://devpost.com/software/synthetic-atlas',
    });
    const bad = await submit({
      eventId,
      github: 'https://github.com/synthetic/does-not-exist',
      devpost: dp(`other-${unique()}`),
    });
    const goodId = (good.body['project'] as { id: string }).id;
    const badId = (bad.body['project'] as { id: string }).id;
    const setup = await captureSetup(db);
    await setup.loop.drain();
    const rows = await state(eventId);
    for (const snapshot of rows.snapshots) {
      const declared = rows.sources.find((source) => source.id === snapshot.projectSourceId);
      expect(declared?.projectId).toBe(snapshot.projectId); // a snapshot belongs to the source's own project
      expect(snapshot.sourceUrl).toBe(declared?.url);
    }
    expect(
      rows.snapshots
        .filter((s) => s.projectId === goodId)
        .every((s) => s.status === 'captured' || s.status === 'partial'),
    ).toBe(true);
    const githubOfBad = requireValue(
      rows.sources.find((s) => s.projectId === badId && s.sourceType === 'github'),
    );
    expect(rows.snapshots.find((s) => s.projectSourceId === githubOfBad.id)?.status).toBe('failed');
    // the same submission again changes nothing; a manual retry adds a capture for that one source only
    const before = await totals();
    const replay = await submit({
      eventId,
      github: 'https://github.com/synthetic/does-not-exist',
      devpost:
        rows.sources.find((s) => s.projectId === badId && s.sourceType === 'devpost')?.url ?? '',
      key: bad.key,
    });
    expect(replay.body['result']).toBe('replayed');
    expect(await totals()).toEqual(before);
    const retry = await app.inject({
      method: 'POST',
      url: `/projects/${badId}/sources/${githubOfBad.id}/captures`,
      headers: bearer(TEST_TOKENS.organizer),
    });
    expect(retry.statusCode).toBe(202);
    const afterRetry = await state(eventId);
    expect(afterRetry.sources).toHaveLength(rows.sources.length);
    expect(
      afterRetry.snapshots
        .filter((s) => s.projectSourceId === githubOfBad.id)
        .map((s) => s.captureNumber)
        .sort(),
    ).toEqual([1, 2]);
    expect(afterRetry.snapshots.filter((s) => s.projectId === goodId)).toHaveLength(2);
  });

  // -- detection of historical mixed projects -------------------------------------------------------------------------------

  it('detects projects that mix several links and links claimed by several projects, read-only', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const post = (url: string, payload: unknown) =>
      app.inject({
        method: 'POST',
        url,
        headers: bearer(TEST_TOKENS.organizer),
        payload: payload as object,
      });
    const mixed = (await post(`/events/${eventId}/projects`, { name: `Mixed ${n}` })).json<{
      id: string;
    }>().id;
    await post(`/projects/${mixed}/sources`, { sourceType: 'github', url: gh(`mix-${n}`) });
    await post(`/projects/${mixed}/sources`, { sourceType: 'devpost', url: dp(`mix-${n}-a`) });
    await post(`/projects/${mixed}/sources`, { sourceType: 'devpost', url: dp(`mix-${n}-b`) });
    const twin = (await post(`/events/${eventId}/projects`, { name: `Twin ${n}` })).json<{
      id: string;
    }>().id;
    await post(`/projects/${twin}/sources`, { sourceType: 'github', url: gh(`mix-${n}`) });
    const clean = await submit({ eventId, github: gh(`clean-${n}`), devpost: dp(`clean-${n}`) });
    const cleanId = (clean.body['project'] as { id: string }).id;
    const before = await totals();
    const report = await app.inject({
      method: 'GET',
      url: `/events/${eventId}/submission-integrity`,
      headers: bearer(TEST_TOKENS.judge),
    });
    expect(report.statusCode).toBe(200);
    const body = report.json<{
      projectsChecked: number;
      projectsWithoutSubmissionRecord: number;
      findings: { kind: string; sourceType: string; urls: string[]; projectIds: string[] }[];
    }>();
    expect(body.projectsChecked).toBe(3);
    expect(body.projectsWithoutSubmissionRecord).toBe(2);
    expect(body.findings).toEqual(
      expect.arrayContaining([
        {
          kind: 'multiple_sources_of_one_type',
          sourceType: 'devpost',
          urls: [dp(`mix-${n}-a`), dp(`mix-${n}-b`)],
          projectIds: [mixed],
        },
        {
          kind: 'shared_source_url',
          sourceType: 'github',
          urls: [gh(`mix-${n}`)],
          projectIds: [mixed, twin].sort(),
        },
      ]),
    );
    expect(body.findings.flatMap((f) => f.projectIds)).not.toContain(cleanId);
    expect(await totals()).toEqual(before);
  });
});
