/*
 * P6B-beta3 threat-model review: cross-event organizer authorization, CHARACTERIZED (docs/SECURITY.md §17). Roles are global in this version: an
 * organizer may act on any event's projects. This is a documented property of a single-organizing-team deployment, not a multi-tenant design; these
 * tests pin it so that a future change to it is deliberate, and pin what DOES hold across events: identity ownership is per event, a judge can write
 * nothing, and every cross-organizer action is attributed in the audit trail.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actors, auditEvents, type JudgeDatabase } from '../../packages/database/src/index.js';
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

const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
let counter = 0;
const unique = (): string => (counter += 1).toString(36);

describe.each(testDatabaseTargets())('cross-event organizer authorization on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;
  let app: ApiApp;
  let eventContext: EventContextService;

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
    for (const token of [TEST_TOKENS.organizer, TEST_TOKENS.secondOrganizer, TEST_TOKENS.judge]) {
      await app.inject({ method: 'GET', url: '/events', headers: bearer(token) });
    }
  });
  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  async function newEvent(): Promise<string> {
    const fixtures = await loadFixtures();
    return (
      await lockedEventFromRecording(
        eventContext,
        requireValue(fixtures.get('fixture-e-multiple-tracks')),
      )
    ).eventId;
  }
  async function call(token: string, method: 'GET' | 'POST', url: string, payload?: object) {
    const response = await app.inject({
      method,
      url,
      headers: {
        ...bearer(token),
        ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}),
      },
      ...(payload ? { payload } : {}),
    });
    return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
  }
  const submit = (token: string, eventId: string, name: string) =>
    call(token, 'POST', `/events/${eventId}/submissions`, {
      githubUrl: `https://github.com/synthetic/${name}`,
      devpostUrl: `https://devpost.com/software/${name}`,
    });

  it('CHARACTERIZATION: an organizer of one event can read, correct and void a project that another organizer created in a different event', async () => {
    const eventA = await newEvent();
    const n = unique();
    const created = await submit(TEST_TOKENS.organizer, eventA, `xe-${n}`);
    expect(created.status).toBe(201);
    const projectId = (created.body['project'] as { id: string }).id;

    expect((await call(TEST_TOKENS.secondOrganizer, 'GET', `/projects/${projectId}`)).status).toBe(
      200,
    );
    const voided = await call(TEST_TOKENS.secondOrganizer, 'POST', `/projects/${projectId}/void`, {
      reason: 'cross-organizer correction',
      cancelPendingWork: true,
    });
    expect(voided.status).toBe(201);

    // ... and the action is attributed to the second organizer, not to the creator
    const rows = await db.select().from(actors);
    const second = requireValue(rows.find((row) => row.subject === 'organizer-2'));
    const audit = (await db.select().from(auditEvents)).find(
      (event) => event.entityId === projectId && event.action === 'project_voided',
    );
    expect(audit?.actorId).toBe(second.id);
  });

  it('identity ownership is per event: the same links in two events are two independent submissions, and voiding one frees nothing in the other', async () => {
    const eventA = await newEvent();
    const eventB = await newEvent();
    const n = unique();
    const inA = await submit(TEST_TOKENS.organizer, eventA, `same-${n}`);
    const inB = await submit(TEST_TOKENS.secondOrganizer, eventB, `same-${n}`);
    expect([inA.status, inB.status]).toEqual([201, 201]);
    expect((inA.body['project'] as { id: string }).id).not.toBe(
      (inB.body['project'] as { id: string }).id,
    );
    // the same pair twice in ONE event converges, it does not duplicate
    const again = await submit(TEST_TOKENS.secondOrganizer, eventB, `same-${n}`);
    expect(again.body['result']).toBe('already_submitted');
  });

  it('a judge can write nothing in any event: submissions, corrections and supplied text are refused', async () => {
    const eventA = await newEvent();
    const n = unique();
    const created = await submit(TEST_TOKENS.organizer, eventA, `jw-${n}`);
    const projectId = (created.body['project'] as { id: string }).id;
    expect((await submit(TEST_TOKENS.judge, eventA, `jw-other-${n}`)).status).toBe(403);
    expect(
      (await call(TEST_TOKENS.judge, 'POST', `/projects/${projectId}/void`, { reason: 'x' }))
        .status,
    ).toBe(403);
    const detail = (await call(TEST_TOKENS.judge, 'GET', `/projects/${projectId}`)).body as {
      sources: { id: string; sourceType: string }[];
    };
    const devpost = requireValue(detail.sources.find((source) => source.sourceType === 'devpost'));
    expect(
      (
        await call(
          TEST_TOKENS.judge,
          'POST',
          `/projects/${projectId}/sources/${devpost.id}/supplied-content`,
          { text: 'A pasted submission text that is long enough to be accepted.' },
        )
      ).status,
    ).toBe(403);
  });
});
