import { Writable } from 'node:stream';
import type { ReplayRecordingInput } from '@judge-copilot/context';
import { analysisRuns, auditEvents, sourceSnapshots } from '@judge-copilot/database';
import {
  ApiErrorBody,
  CaptureAllResponse,
  CaptureRequestedResponse,
  ProjectDetail,
  ProjectRecord,
  ProjectSourceRecord,
  SnapshotDetail,
} from '@judge-copilot/schemas';
import { createLogger } from '@judge-copilot/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, SERVICE_NAME, type ApiApp } from '../app.js';
import type { EventContextService } from '../event-context/service.js';
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
import { ProjectService } from './service.js';

const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
const MISSING = '5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e';
const [[, openDatabase]] = testDatabaseTargets() as [[string, () => Promise<TestDatabase>]];

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

describe('M2 project and source HTTP API', () => {
  let testDb: TestDatabase;
  let fixtures: Map<string, ReplayRecordingInput>;
  let eventContext: EventContextService;
  let app: ApiApp;

  async function call(
    method: Method,
    url: string,
    payload?: unknown,
    token: string | null = TEST_TOKENS.organizer,
  ) {
    const response = await app.inject({
      method,
      url,
      ...(token ? { headers: bearer(token) } : {}),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return {
      status: response.statusCode,
      body: response.json<unknown>(),
      headers: response.headers,
    };
  }
  const code = (body: unknown) => ApiErrorBody.parse(body).error.code;

  async function lockedEvent() {
    return lockedEventFromRecording(
      eventContext,
      requireValue(fixtures.get('fixture-e-multiple-tracks')),
    );
  }

  async function project(name = 'Synthetic Atlas', trackKeys: string[] = []) {
    const { eventId } = await lockedEvent();
    const created = await call('POST', `/events/${eventId}/projects`, {
      name,
      teamName: 'Team Atlas',
      trackKeys,
    });
    expect(created.status).toBe(201);
    return { eventId, project: ProjectRecord.parse(created.body) };
  }

  beforeAll(async () => {
    testDb = await openDatabase();
    fixtures = await loadFixtures();
    eventContext = replayService(testDb.db, fixtures.values());
    app = buildApp({
      logger,
      db: testDb.db,
      verifier: fakeVerifier(),
      eventContext,
      projects: new ProjectService({ db: testDb.db }),
    });
  });

  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  it('creates a project in an existing event with tracks validated against the locked context', async () => {
    const { eventId, project: created } = await project('Atlas', ['health']);
    expect(created).toMatchObject({ eventId, name: 'Atlas', teamName: 'Team Atlas' });
    expect(created.tracks).toEqual([
      expect.objectContaining({ trackKey: 'health', contextVersion: 1 }),
    ]);
    expect(created.createdByActorId).not.toBeNull();
    const list = await call('GET', `/events/${eventId}/projects`, undefined, TEST_TOKENS.judge);
    expect((list.body as { projects: unknown[] }).projects).toHaveLength(1);
    // No implicit assessment: creating a project starts no analysis run.
    const runs = await testDb.db
      .select()
      .from(analysisRuns)
      .where(eq(analysisRuns.projectId, created.id));
    expect(runs).toEqual([]);
  });

  it('rejects unknown events, unknown tracks, duplicate names and events without a locked context', async () => {
    expect(code((await call('POST', `/events/${MISSING}/projects`, { name: 'X' })).body)).toBe(
      'EVENT_NOT_FOUND',
    );
    const { eventId } = await lockedEvent();
    const unknown = await call('POST', `/events/${eventId}/projects`, {
      name: 'X',
      trackKeys: ['health', 'web3'],
    });
    expect([unknown.status, code(unknown.body)]).toEqual([422, 'UNKNOWN_TRACK']);
    expect(ApiErrorBody.parse(unknown.body).error.details).toEqual({ unknownTrackKeys: ['web3'] });
    await call('POST', `/events/${eventId}/projects`, { name: 'Same' });
    const duplicate = await call('POST', `/events/${eventId}/projects`, { name: 'Same' });
    expect([duplicate.status, code(duplicate.body)]).toEqual([409, 'PROJECT_NAME_TAKEN']);
    const unlocked = await call('POST', '/events', { name: 'Open', slug: 'open-no-context' });
    const unlockedId = (unlocked.body as { id: string }).id;
    const refused = await call('POST', `/events/${unlockedId}/projects`, { name: 'X' });
    expect([refused.status, code(refused.body)]).toEqual([409, 'NO_LOCKED_CONTEXT']);
    const extra = await call('POST', `/events/${eventId}/projects`, {
      name: 'X',
      eventId: MISSING,
    });
    expect(extra.status).toBe(400);
  });

  it('keeps track history when a later context version supersedes the validated one', async () => {
    const recording = requireValue(fixtures.get('fixture-e-multiple-tracks'));
    const { eventId, versionId } = await lockedEventFromRecording(eventContext, recording);
    const created = ProjectRecord.parse(
      (
        await call('POST', `/events/${eventId}/projects`, {
          name: 'Historic',
          trackKeys: ['education'],
        })
      ).body,
    );
    const v2 = await eventContext.createContextVersion(eventId, {
      changeReason: 'Organizer correction',
    });
    await eventContext.lockContext(eventId, v2.id);
    const after = ProjectDetail.parse((await call('GET', `/projects/${created.id}`)).body);
    expect(after.tracks).toEqual([
      expect.objectContaining({
        trackKey: 'education',
        contextVersionId: versionId,
        contextVersion: 1,
      }),
    ]);
  });

  it('declares all four source types, normalizing URLs and rejecting duplicates and bad shapes', async () => {
    const { project: created } = await project();
    const base = `/projects/${created.id}/sources`;
    const declared = [
      [
        'devpost',
        'https://devpost.com/software/Synthetic-Atlas/',
        'https://devpost.com/software/synthetic-atlas',
      ],
      ['github', 'https://github.com/Synthetic/Atlas.git', 'https://github.com/synthetic/atlas'],
      ['deployment', 'https://atlas.example.org/#top', 'https://atlas.example.org/'],
      ['video', 'https://youtu.be/AAAAAAAAAAA', 'https://www.youtube.com/watch?v=AAAAAAAAAAA'],
    ] as const;
    for (const [sourceType, url, normalized] of declared) {
      const added = await call('POST', base, { sourceType, url });
      expect(added.status).toBe(201);
      expect(ProjectSourceRecord.parse(added.body)).toMatchObject({
        sourceType,
        url: normalized,
        latestSnapshot: null,
      });
    }
    const listed = (await call('GET', base, undefined, TEST_TOKENS.judge)).body as {
      sources: ProjectSourceRecord[];
    };
    expect(listed.sources.map((source) => source.position)).toEqual([0, 1, 2, 3]);

    const duplicate = await call('POST', base, {
      sourceType: 'github',
      url: 'https://github.com/synthetic/atlas/',
    });
    expect([duplicate.status, code(duplicate.body)]).toEqual([409, 'DUPLICATE_SOURCE']);
    for (const [sourceType, url, reason] of [
      ['github', 'https://github.com/synthetic/atlas/tree/main', 'unsupported_path'],
      ['devpost', 'https://example.org/software/x', 'unsupported_host'],
      ['deployment', 'file:///etc/passwd', 'scheme_not_allowed'],
      ['deployment', 'https://user:pw@atlas.example.org/', 'credentials_in_url'],
    ] as const) {
      const bad = await call('POST', base, { sourceType, url });
      expect([bad.status, code(bad.body)]).toEqual([422, 'INVALID_SOURCE_URL']);
      expect(ApiErrorBody.parse(bad.body).error.details).toEqual({ sourceType, reason });
      expect(JSON.stringify(bad.body)).not.toContain('pw@');
    }
    expect((await call('POST', base, { sourceType: 'ftp', url: 'x' })).status).toBe(400);
  });

  it('refuses edits of declarations and snapshots, and cross-project references', async () => {
    const { project: a } = await project('A');
    const { project: b } = await project('B');
    const source = ProjectSourceRecord.parse(
      (
        await call('POST', `/projects/${a.id}/sources`, {
          sourceType: 'github',
          url: 'https://github.com/team/a',
        })
      ).body,
    );
    for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
      const response = await call(method, `/projects/${a.id}/sources/${source.id}`, {
        url: 'https://github.com/team/z',
      });
      expect([response.status, code(response.body)]).toEqual([405, 'SOURCE_IMMUTABLE']);
    }
    // Source of project A addressed through project B.
    const cross = await call('POST', `/projects/${b.id}/sources/${source.id}/captures`);
    expect([cross.status, code(cross.body)]).toEqual([404, 'SOURCE_NOT_FOUND']);
    const requested = CaptureRequestedResponse.parse(
      (await call('POST', `/projects/${a.id}/sources/${source.id}/captures`)).body,
    );
    const crossSnapshot = await call('GET', `/projects/${b.id}/snapshots/${requested.snapshot.id}`);
    expect([crossSnapshot.status, code(crossSnapshot.body)]).toEqual([404, 'SNAPSHOT_NOT_FOUND']);
    for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
      const response = await call(method, `/projects/${a.id}/snapshots/${requested.snapshot.id}`, {
        status: 'captured',
      });
      expect([response.status, code(response.body)]).toEqual([405, 'SNAPSHOT_IMMUTABLE']);
    }
  });

  it('answers a capture request with 202 and a new pending snapshot plus pending run; recapture gets the next number', async () => {
    const { project: created } = await project();
    const source = ProjectSourceRecord.parse(
      (
        await call('POST', `/projects/${created.id}/sources`, {
          sourceType: 'deployment',
          url: 'https://atlas.example.org/',
        })
      ).body,
    );
    const first = await call(
      'POST',
      `/projects/${created.id}/sources/${source.id}/captures`,
      undefined,
      TEST_TOKENS.judge,
    );
    expect(first.status).toBe(202);
    const requested = CaptureRequestedResponse.parse(first.body);
    expect(requested.snapshot).toMatchObject({
      status: 'pending',
      captureNumber: 1,
      contentHash: null,
      completedAt: null,
    });
    const [run] = await testDb.db
      .select()
      .from(analysisRuns)
      .where(eq(analysisRuns.id, requested.runId));
    expect(run).toMatchObject({
      state: 'pending',
      runType: 'project_source_capture',
      startedAt: null,
      sourceSnapshotId: requested.snapshot.id,
    });

    const again = await call('POST', `/projects/${created.id}/sources/${source.id}/captures`);
    expect([again.status, code(again.body)]).toEqual([409, 'CAPTURE_ALREADY_PENDING']);
    // Finish capture 1 directly (the worker's job), then capture again.
    await testDb.db.execute(
      sql`UPDATE source_snapshots SET status = 'failed', failure_category = 'timeout', failure_metadata = '{}'::jsonb, completed_at = now() WHERE id = ${requested.snapshot.id}`,
    );
    const second = CaptureRequestedResponse.parse(
      (await call('POST', `/projects/${created.id}/sources/${source.id}/captures`)).body,
    );
    expect(second.snapshot.captureNumber).toBe(2);
    expect(second.snapshot.id).not.toBe(requested.snapshot.id);
    const snapshots = (await call('GET', `/projects/${created.id}/snapshots`)).body as {
      snapshots: { captureNumber: number; status: string }[];
    };
    expect(
      snapshots.snapshots.map((snapshot) => [snapshot.captureNumber, snapshot.status]),
    ).toEqual([
      [2, 'pending'],
      [1, 'failed'],
    ]);
    const detail = SnapshotDetail.parse(
      (await call('GET', `/projects/${created.id}/snapshots/${requested.snapshot.id}`)).body,
    );
    expect(detail).toMatchObject({
      status: 'failed',
      failureCategory: 'timeout',
      run: { state: 'pending' },
    });

    const all = CaptureAllResponse.parse(
      (await call('POST', `/projects/${created.id}/captures`)).body,
    );
    expect(all).toEqual({ requested: [], skippedSourceIds: [source.id] });
  });

  it('enforces authentication and role permissions on every M1 and M2 route', async () => {
    const { eventId, project: created } = await project('Auth');
    const unauthenticated = await call('GET', `/projects/${created.id}`, undefined, null);
    expect([unauthenticated.status, code(unauthenticated.body)]).toEqual([401, 'UNAUTHENTICATED']);
    expect(unauthenticated.headers['www-authenticate']).toBe('Bearer');
    for (const [method, url] of [
      ['GET', '/events'],
      ['POST', '/events'],
      ['GET', `/events/${eventId}/projects`],
      ['POST', `/events/${eventId}/projects`],
      ['GET', `/projects/${created.id}/sources`],
      ['POST', `/projects/${created.id}/captures`],
      ['GET', '/me'],
    ] as const) {
      expect((await call(method, url, {}, null)).status, `${method} ${url}`).toBe(401);
      expect((await call(method, url, {}, 'forged-credential')).status, `${method} ${url}`).toBe(
        401,
      );
      expect((await call(method, url, {}, TEST_TOKENS.noRole)).status, `${method} ${url}`).toBe(
        403,
      );
    }
    const malformed = await app.inject({
      method: 'GET',
      url: '/events',
      headers: { authorization: `Basic ${TEST_TOKENS.organizer}` },
    });
    expect(malformed.statusCode).toBe(401);
    // Judges read and may request captures, but never write Event Context or projects.
    expect(
      (await call('GET', `/projects/${created.id}`, undefined, TEST_TOKENS.judge)).status,
    ).toBe(200);
    expect((await call('GET', `/events/${eventId}`, undefined, TEST_TOKENS.judge)).status).toBe(
      200,
    );
    expect(
      code(
        (await call('POST', `/events/${eventId}/projects`, { name: 'J' }, TEST_TOKENS.judge)).body,
      ),
    ).toBe('FORBIDDEN');
    expect(
      code(
        (
          await call(
            'POST',
            `/projects/${created.id}/sources`,
            { sourceType: 'github', url: 'https://github.com/a/b' },
            TEST_TOKENS.judge,
          )
        ).body,
      ),
    ).toBe('FORBIDDEN');
    expect(
      code(
        (await call('POST', '/events', { name: 'J', slug: 'judge-event' }, TEST_TOKENS.judge)).body,
      ),
    ).toBe('FORBIDDEN');
    expect(
      code((await call('POST', `/events/${eventId}/context-versions`, {}, TEST_TOKENS.judge)).body),
    ).toBe('FORBIDDEN');
    // Organizers manage everything.
    expect(
      (
        await call('POST', `/projects/${created.id}/sources`, {
          sourceType: 'github',
          url: 'https://github.com/a/b',
        })
      ).status,
    ).toBe(201);
    const me = await call('GET', '/me', undefined, TEST_TOKENS.judge);
    expect(me.body).toMatchObject({
      actor: { issuer: 'urn:test', subject: 'judge-1', roles: ['judge'] },
    });
  });

  it('records the authenticated actor in audit events and never stores or echoes the credential', async () => {
    const { project: created } = await project('Audited', ['health']);
    const audits = await testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, created.id));
    expect(audits.map((audit) => audit.action).sort()).toEqual([
      'project_created',
      'project_track_declared',
    ]);
    expect(audits.every((audit) => audit.actorId === created.createdByActorId)).toBe(true);
    const dump = JSON.stringify(
      await testDb.db.execute(
        sql`SELECT row_to_json(a) FROM audit_events a UNION ALL SELECT row_to_json(x) FROM actors x`,
      ),
    );
    for (const token of Object.values(TEST_TOKENS)) expect(dump).not.toContain(token);
    // Even the unauthenticated error body never quotes the credential.
    const response = await call(
      'GET',
      `/projects/${created.id}`,
      undefined,
      'credential-that-must-not-echo',
    );
    expect(JSON.stringify(response.body)).not.toContain('credential-that-must-not-echo');
  });

  it('validates identifiers and answers 404 for unknown resources', async () => {
    expect((await call('GET', '/projects/not-a-uuid')).status).toBe(400);
    expect(code((await call('GET', `/projects/${MISSING}`)).body)).toBe('PROJECT_NOT_FOUND');
    const { project: created } = await project('Lookups');
    expect(code((await call('GET', `/projects/${created.id}/snapshots/${MISSING}`)).body)).toBe(
      'SNAPSHOT_NOT_FOUND',
    );
    expect(
      code((await call('POST', `/projects/${created.id}/sources/${MISSING}/captures`)).body),
    ).toBe('SOURCE_NOT_FOUND');
    expect(
      code(
        (await call('GET', `/projects/${created.id}/snapshots/${MISSING}/artifacts/${MISSING}`))
          .body,
      ),
    ).toBe('ARTIFACT_NOT_FOUND');
    // No scoring, evidence or AI routes exist.
    for (const url of [
      `/projects/${created.id}/score`,
      `/projects/${created.id}/evidence`,
      `/projects/${created.id}/analyze`,
    ]) {
      expect((await call('POST', url)).status).toBe(404);
    }
    const snapshotRows = await testDb.db
      .select()
      .from(sourceSnapshots)
      .where(eq(sourceSnapshots.projectId, created.id));
    expect(snapshotRows).toEqual([]);
  });
});

describe('credential hygiene in logs', () => {
  it('never writes the bearer credential to API logs, even at trace level', async () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const [[, open]] = testDatabaseTargets() as [[string, () => Promise<TestDatabase>]];
    const testDb = await open();
    const app = buildApp({
      logger: createLogger({ service: SERVICE_NAME, level: 'trace', destination }),
      db: testDb.db,
      verifier: fakeVerifier(),
      projects: new ProjectService({ db: testDb.db }),
    });
    await app.inject({
      method: 'GET',
      url: `/projects/${MISSING}`,
      headers: bearer(TEST_TOKENS.organizer),
    });
    await app.inject({
      method: 'GET',
      url: `/projects/${MISSING}`,
      headers: bearer('rejected-secret-credential'),
    });
    await app.close();
    await testDb.close();
    expect(lines.length).toBeGreaterThan(0);
    const output = lines.join('');
    expect(output).not.toContain(TEST_TOKENS.organizer);
    expect(output).not.toContain('rejected-secret-credential');
  });
});

describe('M2 routes without a database or verifier', () => {
  it('answers 503 for project routes without a database', async () => {
    const app = buildApp({ logger });
    const response = await app.inject({ method: 'GET', url: `/projects/${MISSING}` });
    expect([response.statusCode, ApiErrorBody.parse(response.json()).error.code]).toEqual([
      503,
      'DATABASE_NOT_CONFIGURED',
    ]);
    await app.close();
  });

  it('fails closed with 503 AUTH_NOT_CONFIGURED when no verifier is configured', async () => {
    const [[, open]] = testDatabaseTargets() as [[string, () => Promise<TestDatabase>]];
    const testDb = await open();
    const app = buildApp({
      logger,
      db: testDb.db,
      projects: new ProjectService({ db: testDb.db }),
    });
    const response = await app.inject({
      method: 'GET',
      url: `/projects/${MISSING}`,
      headers: bearer(TEST_TOKENS.organizer),
    });
    expect([response.statusCode, ApiErrorBody.parse(response.json()).error.code]).toEqual([
      503,
      'AUTH_NOT_CONFIGURED',
    ]);
    await app.close();
    await testDb.close();
  });
});
