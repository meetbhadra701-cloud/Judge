import type { ReplayRecordingInput } from '@judge-copilot/context';
import {
  ApiErrorBody,
  ContextVersionDetail,
  EventContextLockedSnapshot,
  EventDetail,
  EventSourceRecord,
} from '@judge-copilot/schemas';
import { createLogger } from '@judge-copilot/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, SERVICE_NAME, type ApiApp } from '../app.js';
import {
  loadFixtures,
  replayService,
  requireValue,
  serviceWith,
  testDatabaseTargets,
  type TestDatabase,
} from '../testing/harness.js';

const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
const MISSING = '5b4d7c3e-2f1a-4c6b-9d8e-7f6a5b4c3d2e';

async function call(app: ApiApp, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: response.statusCode, body: response.json<unknown>() };
}

function errorCode(body: unknown): string {
  return ApiErrorBody.parse(body).error.code;
}

const [[, openDatabase]] = testDatabaseTargets() as [[string, () => Promise<TestDatabase>]];

describe('Event Context HTTP API', () => {
  let testDb: TestDatabase;
  let fixtures: Map<string, ReplayRecordingInput>;
  let app: ApiApp;

  beforeAll(async () => {
    testDb = await openDatabase();
    fixtures = await loadFixtures();
    app = buildApp({ logger, eventContext: replayService(testDb.db, fixtures.values()) });
  });

  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  it('runs the whole workflow over HTTP with typed responses', async () => {
    const recording = requireValue(fixtures.get('fixture-c-conflicting-authority'));
    const created = await call(app, 'POST', '/events', {
      name: 'Demo Hackathon',
      slug: 'demo-hackathon-http',
    });
    expect(created.status).toBe(201);
    const eventId = EventDetail.shape.event.parse(created.body).id;

    const version = await call(app, 'POST', `/events/${eventId}/context-versions`, {});
    expect(version.status).toBe(201);
    const versionId = ContextVersionDetail.parse(version.body).id;
    const base = `/events/${eventId}/context-versions/${versionId}`;

    for (const source of recording.sources) {
      const added = await call(app, 'POST', `${base}/sources`, {
        sourceType: source.sourceType,
        authority: source.authority,
        title: source.title,
        url: source.url,
        normalizedText: source.normalizedText,
      });
      expect(added.status).toBe(201);
      EventSourceRecord.parse(added.body);
    }
    const sources = await call(app, 'GET', `${base}/sources`);
    expect((sources.body as { sources: unknown[] }).sources).toHaveLength(2);

    const builtResponse = await call(app, 'POST', `${base}/build`);
    expect(builtResponse.status).toBe(200);
    const builtDetail = ContextVersionDetail.parse(builtResponse.body);
    expect(builtDetail.document?.conflicts[0]?.resolution.status).toBe('resolved_by_authority');

    const document = structuredClone(builtDetail.document);
    if (!document) throw new Error('missing document');
    document.judgingFormat.statement = 'Three-minute stage presentations, followed by questions.';
    const edited = await call(app, 'PATCH', base, { document });
    expect(edited.status).toBe(200);
    expect(ContextVersionDetail.parse(edited.body).document?.judgingFormat.humanModified).toBe(
      true,
    );

    const locked = await call(app, 'POST', `${base}/lock`);
    expect(locked.status).toBe(200);
    expect(ContextVersionDetail.parse(locked.body).status).toBe('locked');

    const current = await call(app, 'GET', `/events/${eventId}/context`);
    expect(current.status).toBe(200);
    const snapshot = EventContextLockedSnapshot.parse(current.body);
    expect(snapshot).toMatchObject({ versionId, version: 1, status: 'locked' });
    expect(snapshot.document.conflicts).toHaveLength(1);

    const mutate = await call(app, 'PATCH', base, { document });
    expect(mutate.status).toBe(409);
    expect(errorCode(mutate.body)).toBe('LOCKED_CONTEXT_IMMUTABLE');
    const addLate = await call(app, 'POST', `${base}/sources`, {
      sourceType: 'pasted_text',
      authority: 'organizer_guidance',
      title: 'Late',
      normalizedText: 'Late.',
    });
    expect(addLate.status).toBe(409);

    const event = EventDetail.parse((await call(app, 'GET', `/events/${eventId}`)).body);
    expect(event.lockedVersionId).toBe(versionId);
    const list = await call(app, 'GET', '/events');
    expect(
      (list.body as { events: { id: string }[] }).events.some((item) => item.id === eventId),
    ).toBe(true);
  });

  it.each([
    ['GET', '/events/not-a-uuid'],
    ['GET', `/events/${MISSING}/context-versions/123`],
    ['POST', `/events/x/context-versions/${MISSING}/lock`],
  ] as const)('rejects malformed UUIDs in %s %s with 400', async (method, url) => {
    const response = await call(app, method, url);
    expect(response.status).toBe(400);
    const parsed = ApiErrorBody.parse(response.body);
    expect(parsed.error.code).toBe('INVALID_REQUEST');
    expect(parsed.error.details).toMatchObject({ location: 'params' });
  });

  it('rejects invalid bodies with 400 and issue paths, never echoing values', async () => {
    const badEvent = await call(app, 'POST', '/events', { name: '', slug: 'Not A Slug' });
    expect(badEvent.status).toBe(400);
    const issues = (
      ApiErrorBody.parse(badEvent.body).error.details as { issues: { path: string }[] }
    ).issues;
    expect(issues.map((issue) => issue.path).sort()).toEqual(['name', 'slug']);
    expect(JSON.stringify(badEvent.body)).not.toContain('Not A Slug');

    const created = await call(app, 'POST', '/events', {
      name: 'Body checks',
      slug: 'body-checks',
    });
    const eventId = (created.body as { id: string }).id;
    const version = await call(app, 'POST', `/events/${eventId}/context-versions`, {});
    const versionId = (version.body as { id: string }).id;
    const badSource = await call(
      app,
      'POST',
      `/events/${eventId}/context-versions/${versionId}/sources`,
      {
        sourceType: 'url_text',
        authority: 'official_event_rules',
        title: 'Rules',
        url: 'http://169.254.169.254/latest',
        normalizedText: 'x',
      },
    );
    expect(badSource.status).toBe(400);
    const badPatch = await call(app, 'PATCH', `/events/${eventId}/context-versions/${versionId}`, {
      document: {},
    });
    expect(badPatch.status).toBe(400);
    const notJson = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { 'content-type': 'application/json' },
      payload: '{"name":',
    });
    expect(notJson.statusCode).toBe(400);
    expect(errorCode(notJson.json())).toBe('INVALID_REQUEST');
  });

  it('maps domain errors to stable codes and statuses', async () => {
    expect(errorCode((await call(app, 'GET', `/events/${MISSING}`)).body)).toBe('EVENT_NOT_FOUND');
    const noContext = await call(app, 'POST', '/events', {
      name: 'No context',
      slug: 'no-context-yet',
    });
    const eventId = (noContext.body as { id: string }).id;
    const missingContext = await call(app, 'GET', `/events/${eventId}/context`);
    expect(missingContext.status).toBe(404);
    expect(errorCode(missingContext.body)).toBe('NO_LOCKED_CONTEXT');
    const missingVersion = await call(app, 'GET', `/events/${eventId}/context-versions/${MISSING}`);
    expect(missingVersion.status).toBe(404);
    expect(errorCode(missingVersion.body)).toBe('CONTEXT_VERSION_NOT_FOUND');

    const recording = requireValue(fixtures.get('fixture-d-malformed-rubric'));
    const version = await call(app, 'POST', `/events/${eventId}/context-versions`, {});
    const base = `/events/${eventId}/context-versions/${(version.body as { id: string }).id}`;
    const noSources = await call(app, 'POST', `${base}/build`);
    expect([noSources.status, errorCode(noSources.body)]).toEqual([422, 'NO_CONTEXT_SOURCES']);
    for (const source of recording.sources) {
      await call(app, 'POST', `${base}/sources`, { ...source, ref: undefined });
    }
    expect((await call(app, 'POST', `${base}/build`)).status).toBe(200);
    const lock = await call(app, 'POST', `${base}/lock`);
    expect(lock.status).toBe(422);
    const lockError = ApiErrorBody.parse(lock.body).error;
    expect(lockError.code).toBe('INVALID_RUBRIC_WEIGHTS');
    expect(lockError.details).toMatchObject({
      issues: [{ code: 'INVALID_RUBRIC_WEIGHTS', path: 'rubrics[0]' }],
    });

    const second = await call(app, 'POST', `/events/${eventId}/context-versions`, {});
    expect(second.status).toBe(201);
    const duplicate = await call(app, 'POST', '/events', { name: 'Dup', slug: 'no-context-yet' });
    expect([duplicate.status, errorCode(duplicate.body)]).toEqual([409, 'EVENT_SLUG_TAKEN']);
  });

  it('requires an explicit, boolean confirmation before a rebuild replaces human edits', async () => {
    const recording = requireValue(fixtures.get('fixture-a-clear-official-rubric'));
    const created = await call(app, 'POST', '/events', { name: 'Rebuild', slug: 'rebuild-http' });
    const eventId = (created.body as { id: string }).id;
    const version = await call(app, 'POST', `/events/${eventId}/context-versions`, {});
    const base = `/events/${eventId}/context-versions/${(version.body as { id: string }).id}`;
    for (const source of recording.sources) {
      await call(app, 'POST', `${base}/sources`, { ...source, ref: undefined });
    }
    const first = ContextVersionDetail.parse((await call(app, 'POST', `${base}/build`)).body);
    const document = structuredClone(first.document);
    if (!document) throw new Error('missing document');
    document.judgingFormat.statement = 'Edited over HTTP.';
    const edited = ContextVersionDetail.parse((await call(app, 'PATCH', base, { document })).body);
    expect(edited.rebuildWouldReplaceReviewedChanges).toBe(true);

    const refused = await call(app, 'POST', `${base}/build`);
    expect([refused.status, errorCode(refused.body)]).toEqual([
      409,
      'HUMAN_EDITS_WOULD_BE_REPLACED',
    ]);
    const notBoolean = await call(app, 'POST', `${base}/build`, { replaceHumanEdits: 'yes' });
    expect([notBoolean.status, errorCode(notBoolean.body)]).toEqual([400, 'INVALID_REQUEST']);
    const confirmed = await call(app, 'POST', `${base}/build`, { replaceHumanEdits: true });
    expect(confirmed.status).toBe(200);
    expect(ContextVersionDetail.parse(confirmed.body).document?.judgingFormat.statement).toBe(
      first.document?.judgingFormat.statement,
    );
  });

  it('responds 503 when no extractor is configured for build', async () => {
    const manualApp = buildApp({ logger, eventContext: serviceWith(testDb.db, null) });
    const created = await call(manualApp, 'POST', '/events', {
      name: 'Manual',
      slug: 'manual-http',
    });
    const eventId = (created.body as { id: string }).id;
    const version = await call(manualApp, 'POST', `/events/${eventId}/context-versions`, {});
    const response = await call(
      manualApp,
      'POST',
      `/events/${eventId}/context-versions/${(version.body as { id: string }).id}/build`,
    );
    expect([response.status, errorCode(response.body)]).toEqual([503, 'EXTRACTOR_NOT_CONFIGURED']);
    await manualApp.close();
  });
});

describe('Event Context HTTP API without a database', () => {
  it('keeps /health working and answers Event Context routes with 503', async () => {
    const app = buildApp({ logger });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const response = await app.inject({ method: 'GET', url: '/events' });
    expect(response.statusCode).toBe(503);
    expect(errorCode(response.json())).toBe('DATABASE_NOT_CONFIGURED');
    await app.close();
  });
});
