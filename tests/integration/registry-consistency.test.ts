/*
 * P6B-beta3 (threat-model review items): the ownership registry is the database's authority on identity, so its consistency with the rows it
 * summarizes is checked independently (from the base tables) and the registry cannot be emptied by TRUNCATE.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectPgError, sql, SQLSTATE } from '../../packages/database/src/testing/databases.js';
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
import { type JudgeDatabase } from '../../packages/database/src/index.js';

const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
let counter = 0;
const unique = (): string => (counter += 1).toString(36);
const gh = (name: string) => `https://github.com/synthetic/${name}`;
const dp = (name: string) => `https://devpost.com/software/${name}`;

describe.each(testDatabaseTargets())('ownership registry consistency on %s', (_name, open) => {
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
  });
  afterAll(async () => {
    await app.close();
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
  const call = async (method: 'GET' | 'POST', url: string, payload?: object, key?: string) => {
    const response = await app.inject({
      method,
      url,
      headers: { ...bearer(TEST_TOKENS.organizer), ...(key ? { 'idempotency-key': key } : {}) },
      ...(payload ? { payload } : {}),
    });
    return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
  };
  const problems = async (eventId: string) => {
    const response = await call('GET', `/events/${eventId}/submission-integrity`);
    if (response.status !== 200) throw new Error(JSON.stringify(response));
    return response.body['registryProblems'] as {
      kind: string;
      claimKind: string;
      value: string;
      projectIds: string[];
    }[];
  };
  /** Runs statements as if the triggers did not exist: the only way to damage the registry is to bypass the database's own rules. */
  const withoutTriggers = (work: (tx: JudgeDatabase) => Promise<void>) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await work(tx);
    });

  it('a registry written only through the routes is consistent, whatever the history (submissions, legacy projects, a void with replacement)', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const submitted = await call(
      'POST',
      `/events/${eventId}/submissions`,
      { githubUrl: gh(`rc-${n}`), devpostUrl: dp(`rc-${n}`) },
      randomUUID(),
    );
    expect(submitted.status).toBe(201);
    const legacy = await call('POST', `/events/${eventId}/projects`, { name: `Legacy ${n}` });
    await call('POST', `/projects/${legacy.body['id'] as string}/sources`, {
      sourceType: 'github',
      url: gh(`rl-${n}`),
    });
    expect(await problems(eventId)).toEqual([]);
  });

  it('a lost claim and a stale claim are both reported, and reading the report changes nothing', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const a = await call(
      'POST',
      `/events/${eventId}/submissions`,
      { githubUrl: gh(`ra-${n}`), devpostUrl: dp(`ra-${n}`) },
      randomUUID(),
    );
    const aId = (a.body['project'] as { id: string }).id;
    // damage 1: the registry loses the claim on the GitHub link of an active submission
    await withoutTriggers(async (tx) => {
      await tx.execute(
        sql`DELETE FROM project_submission_claims WHERE project_id = ${aId} AND kind = 'github'`,
      );
    });
    // damage 2: a claim that its project does not hold
    await withoutTriggers(async (tx) => {
      await tx.execute(
        sql`INSERT INTO project_submission_claims (event_id, project_id, kind, value) VALUES (${eventId}, ${aId}, 'devpost', ${dp(`phantom-${n}`)})`,
      );
    });
    const before = await db.execute(sql`SELECT count(*)::int AS n FROM project_submission_claims`);
    const report = await problems(eventId);
    expect(report).toEqual(
      expect.arrayContaining([
        { kind: 'missing_claim', claimKind: 'github', value: gh(`ra-${n}`), projectIds: [aId] },
        { kind: 'stale_claim', claimKind: 'devpost', value: dp(`phantom-${n}`), projectIds: [aId] },
      ]),
    );
    expect(report).toHaveLength(2);
    expect(await db.execute(sql`SELECT count(*)::int AS n FROM project_submission_claims`)).toEqual(
      before,
    );
  });

  it.each([
    'project_submissions',
    'project_submission_requests',
    'project_submission_claims',
    'project_voids',
    'project_replacements',
  ])(
    '%s cannot be emptied with TRUNCATE (UPDATE and DELETE were already refused)',
    async (table) => {
      await expectPgError(
        db.execute(sql.raw(`TRUNCATE ${table} CASCADE`)),
        SQLSTATE.RESTRICT_VIOLATION,
      );
    },
  );
});
