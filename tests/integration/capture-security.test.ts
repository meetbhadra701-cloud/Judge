/*
 * P6B-beta2: attacks on the capture and correction surface, through the real routes and database.
 * (SSRF, redirects, oversized/malformed responses and hostile page content are attacked at the adapter and client level in
 * real-github-capture.test.ts, packages/safe-http and packages/devpost; here: who may ask for what, concurrency, and cross-project reach.)
 */
import { randomUUID } from 'node:crypto';
import { ApiErrorBody } from '../../packages/schemas/src/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  analysisRuns,
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

const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
let counter = 0;
const unique = (): string => (counter += 1).toString(36);

describe.each(testDatabaseTargets())('capture and correction security on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;
  let contendersDb: JudgeDatabase;
  let closeContenders: () => Promise<void> = () => Promise.resolve();
  let app: ApiApp;
  let eventContext: EventContextService;

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
  async function call(
    method: 'GET' | 'POST',
    url: string,
    token: string | null,
    payload?: object,
    key?: string,
  ) {
    const response = await app.inject({
      method,
      url,
      headers: {
        ...(token === null ? {} : bearer(token)),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(payload ? { payload } : {}),
    });
    return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
  }
  async function project(eventId: string) {
    const n = unique();
    const response = await call(
      'POST',
      `/events/${eventId}/submissions`,
      TEST_TOKENS.organizer,
      {
        githubUrl: `https://github.com/synthetic/sec-${n}`,
        devpostUrl: `https://devpost.com/software/sec-${n}`,
      },
      randomUUID(),
    );
    expect(response.status).toBe(201);
    return response.body['project'] as { id: string; sources: { id: string }[] };
  }
  const code = (body: unknown) => ApiErrorBody.parse(body).error.code;

  it('concurrent capture requests for one source: exactly one is queued, the rest are told one is already pending', async () => {
    const eventId = await lockedEvent();
    const p = await project(eventId);
    await captureSetup(db).then((setup) => setup.loop.drain()); // finish the submission's own captures first
    const source = requireValue(p.sources[0]);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        call('POST', `/projects/${p.id}/sources/${source.id}/captures`, TEST_TOKENS.organizer),
      ),
    );
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 202).map((r) => [r.status, code(r.body)])).toEqual(
      Array.from({ length: 7 }, () => [409, 'CAPTURE_ALREADY_PENDING']),
    );
    const pending = (await db.select().from(sourceSnapshots)).filter(
      (s) => s.projectSourceId === source.id && s.status === 'pending',
    );
    expect(pending).toHaveLength(1);
    const runs = (await db.select().from(analysisRuns)).filter(
      (r) => r.sourceSnapshotId === pending[0]?.id,
    );
    expect(runs).toHaveLength(1);
  });

  it('who may ask: no credential 401, no role 403; a source of ANOTHER project (same or other event) is never reachable through this project’s path', async () => {
    const eventId = await lockedEvent();
    const otherEventId = await lockedEvent();
    const a = await project(eventId);
    const b = await project(eventId);
    const c = await project(otherEventId);
    await captureSetup(db).then((setup) => setup.loop.drain());
    const before = (await db.select().from(sourceSnapshots)).length;
    const foreignSource = requireValue(b.sources[0]).id;
    const otherEventSource = requireValue(c.sources[0]).id;
    expect((await call('POST', `/projects/${a.id}/captures`, null)).status).toBe(401);
    expect((await call('POST', `/projects/${a.id}/captures`, TEST_TOKENS.noRole)).status).toBe(403);
    for (const source of [foreignSource, otherEventSource, randomUUID()]) {
      const refused = await call(
        'POST',
        `/projects/${a.id}/sources/${source}/captures`,
        TEST_TOKENS.organizer,
      );
      expect([refused.status, code(refused.body)]).toEqual([404, 'SOURCE_NOT_FOUND']);
    }
    // snapshots of another project are not readable through this one's path either
    const [snapshotOfB] = (await db.select().from(sourceSnapshots)).filter(
      (s) => s.projectId === b.id,
    );
    const cross = await call(
      'GET',
      `/projects/${a.id}/snapshots/${requireValue(snapshotOfB).id}`,
      TEST_TOKENS.organizer,
    );
    expect(cross.status).toBe(404);
    expect((await db.select().from(sourceSnapshots)).length).toBe(before);
  });

  it('a judge may request a capture (it only ever adds a snapshot) but can neither correct a submission nor submit one', async () => {
    const eventId = await lockedEvent();
    const p = await project(eventId);
    await captureSetup(db).then((setup) => setup.loop.drain());
    const source = requireValue(p.sources[0]);
    expect(
      (await call('POST', `/projects/${p.id}/sources/${source.id}/captures`, TEST_TOKENS.judge))
        .status,
    ).toBe(202);
    const key = randomUUID();
    expect(
      (await call('POST', `/projects/${p.id}/void`, TEST_TOKENS.judge, { reason: 'x' }, key))
        .status,
    ).toBe(403);
    expect(
      (
        await call(
          'POST',
          `/events/${eventId}/submissions`,
          TEST_TOKENS.judge,
          {
            githubUrl: 'https://github.com/synthetic/j',
            devpostUrl: 'https://devpost.com/software/j',
          },
          key,
        )
      ).status,
    ).toBe(403);
    expect(
      (await call('GET', `/projects/${p.id}`, TEST_TOKENS.organizer)).body['voided'],
    ).toBeNull();
  });

  it('a hostile request cannot choose provenance: ids, origin, voided state and claims in a body are rejected, not stored', async () => {
    const eventId = await lockedEvent();
    const p = await project(eventId);
    await captureSetup(db).then((setup) => setup.loop.drain());
    for (const extra of [
      { id: randomUUID() },
      { voidedByActorId: randomUUID() },
      { nameBefore: 'x' },
      {
        replacement: {
          githubUrl: 'https://github.com/a/b',
          devpostUrl: 'https://devpost.com/software/b',
          projectId: randomUUID(),
        },
      },
    ]) {
      const response = await call(
        'POST',
        `/projects/${p.id}/void`,
        TEST_TOKENS.organizer,
        { reason: 'x', ...extra },
        randomUUID(),
      );
      expect([response.status, code(response.body)], JSON.stringify(extra)).toEqual([
        400,
        'INVALID_REQUEST',
      ]);
    }
    expect(
      (await call('GET', `/projects/${p.id}`, TEST_TOKENS.organizer)).body['voided'],
    ).toBeNull();
  });
});
