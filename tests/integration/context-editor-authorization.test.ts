import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { events } from '../../packages/database/src/index.js';
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
import { seedLockedContext } from '../../apps/worker/src/testing/assessment-world.js';
import { blankModel, documentFromModel } from '../../apps/web/lib/context-editor.js';

/*
 * P6D (P2-2): the structured editor saves through PATCH /events/:id/context-versions/:id, so who may edit is decided by the API, never by the
 * form. A person without the organizer role, or without a credential, cannot change a draft; a locked version cannot be changed by anyone.
 */

const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
const MODELS = {
  extraction: 'claude-haiku-5-5',
  assessment: 'claude-sonnet-5-5',
  critic: 'claude-sonnet-5-5',
};

interface Created {
  id: string;
}
interface Version {
  status: string;
  version: number;
  document: { rules: unknown[] } | null;
}

describe.each(testDatabaseTargets())('P6D structured editor authorization on %s', (_name, open) => {
  let testDb: TestDatabase;
  let app: ApiApp;

  beforeAll(async () => {
    testDb = await open();
    const fixtures = await loadFixtures();
    app = buildApp({
      logger,
      db: testDb.db,
      verifier: fakeVerifier(),
      eventContext: replayService(testDb.db, fixtures.values()),
      projects: new ProjectService({ db: testDb.db }),
      assessments: new AssessmentService({
        db: testDb.db,
        offline: { provider: { id: 'scripted', mode: 'scripted' }, models: MODELS },
      }),
    });
  });
  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  const call = async (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    token: string | null,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: token === null ? {} : bearer(token),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  it('only an organizer edits a draft; a judge, a user without a role and an anonymous caller change nothing', async () => {
    const slug = `editor-auth-${Date.now().toString(36)}`;
    const created = await call('POST', '/events', TEST_TOKENS.organizer, {
      name: 'Editor Authorization',
      slug,
    });
    expect(created.statusCode).toBe(201);
    const eventId = created.json<Created>().id;
    const draft = await call(
      'POST',
      `/events/${eventId}/context-versions`,
      TEST_TOKENS.organizer,
      {},
    );
    expect(draft.statusCode).toBe(201);
    const versionId = draft.json<Created>().id;
    const url = `/events/${eventId}/context-versions/${versionId}`;

    const built = documentFromModel(blankModel(), []).input;
    if (built === null) throw new Error('the blank model builds');
    const withRule = {
      ...built,
      rules: [{ statement: 'Teams of four.', certainty: 'unclear' as const, sourceIds: [] }],
    };

    const before = (await call('GET', url, TEST_TOKENS.organizer)).json<Version>();

    for (const [who, token, status] of [
      ['judge', TEST_TOKENS.judge, 403],
      ['no role', TEST_TOKENS.noRole, 403],
      ['anonymous', null, 401],
    ] as const) {
      const refused = await call('PATCH', url, token, { document: withRule });
      expect(refused.statusCode, who).toBe(status);
    }
    const untouched = (await call('GET', url, TEST_TOKENS.organizer)).json<Version>();
    expect(untouched.version).toBe(before.version);
    expect(untouched.document?.rules ?? []).toHaveLength(before.document?.rules.length ?? 0);

    const saved = await call('PATCH', url, TEST_TOKENS.organizer, { document: withRule });
    expect(saved.statusCode).toBe(200);
    expect(
      (await call('GET', url, TEST_TOKENS.organizer)).json<Version>().document?.rules,
    ).toHaveLength(1);
  });

  it('a locked version cannot be edited by anyone, not even an organizer: the edit is refused and the stored document is unchanged', async () => {
    const [row] = await testDb.db
      .insert(events)
      .values({ name: 'Locked Editor', slug: `locked-editor-${Date.now().toString(36)}` })
      .returning();
    if (!row) throw new Error('event');
    const { versionId } = await seedLockedContext(testDb.db, row.id, {});
    const url = `/events/${row.id}/context-versions/${versionId}`;
    const before = (await call('GET', url, TEST_TOKENS.organizer)).json<Version>();
    expect(before.status).toBe('locked');
    const built = documentFromModel(blankModel(), []).input;
    if (built === null) throw new Error('the blank model builds');
    const refused = await call('PATCH', url, TEST_TOKENS.organizer, { document: built });
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    expect((await call('GET', url, TEST_TOKENS.organizer)).json<Version>()).toEqual(before);
  });
});
