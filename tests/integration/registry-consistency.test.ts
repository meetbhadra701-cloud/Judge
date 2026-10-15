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

  describe('P6B-beta3-R1 (R7D finding 8): ownership is compared per project', () => {
    const rowsOf = async (query: ReturnType<typeof sql>) => {
      const result = await db.execute(query);
      return (
        Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
      ) as Record<string, string>[];
    };
    const idOfProject = async (eventId: string, name: string): Promise<string> => {
      const created = await call('POST', `/events/${eventId}/projects`, { name });
      return created.body['id'] as string;
    };
    const anActor = async (): Promise<string> =>
      (await rowsOf(sql`SELECT id FROM actors LIMIT 1`))[0]?.['id'] as string;
    const declare = (projectId: string, url: string) =>
      call('POST', `/projects/${projectId}/sources`, { sourceType: 'github', url });

    it('a project that holds SEVERAL links of one type, declared through the routes, owns each of them: nothing is stale', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const id = await idOfProject(eventId, `Multi ${n}`);
      expect((await declare(id, gh(`multi-a-${n}`))).status).toBe(201);
      expect((await declare(id, gh(`multi-b-${n}`))).status).toBe(201);
      const claims = await rowsOf(
        sql`SELECT value FROM project_submission_claims WHERE project_id = ${id} AND kind = 'github' ORDER BY value`,
      );
      expect(claims.map((row) => row['value'])).toEqual([gh(`multi-a-${n}`), gh(`multi-b-${n}`)]);
      expect(await problems(eventId)).toEqual([]);
    });

    it('a pre-registry project with several links (never backfilled) is not reported missing, but a lost claim of a single-link project still is', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const id = await idOfProject(eventId, `Legacy multi ${n}`);
      await declare(id, gh(`lm-a-${n}`));
      await declare(id, gh(`lm-b-${n}`));
      const single = await idOfProject(eventId, `Single ${n}`);
      await declare(single, gh(`single-${n}`));
      await withoutTriggers(async (tx) => {
        await tx.execute(
          sql`DELETE FROM project_submission_claims WHERE project_id = ${id} AND kind = 'github'`,
        );
        await tx.execute(
          sql`DELETE FROM project_submission_claims WHERE project_id = ${single} AND kind = 'github'`,
        );
      });
      expect(await problems(eventId)).toEqual([
        {
          kind: 'missing_claim',
          claimKind: 'github',
          value: gh(`single-${n}`),
          projectIds: [single],
        },
      ]);
    });

    it('two active projects whose labels differ only by case are a shared identity, naming both holders and the registry owner', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const first = await idOfProject(eventId, `Orbit ${n}`);
      let second = '';
      await withoutTriggers(async (tx) => {
        const inserted = await tx.execute(
          sql`INSERT INTO projects (event_id, name) VALUES (${eventId}, ${`ORBIT ${n}`}) RETURNING id`,
        );
        const created = (
          Array.isArray(inserted) ? inserted : (inserted as { rows: { id: string }[] }).rows
        ) as { id: string }[];
        second = created[0]?.id ?? '';
      });
      expect(await problems(eventId)).toEqual([
        {
          kind: 'shared_identity',
          claimKind: 'name',
          value: `orbit ${n}`,
          projectIds: [first, second].sort(),
          ownerProjectId: first,
        },
      ]);
    });

    it('a link declared by two active projects is a shared identity; the claim of only one of them is not "stale"', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const a = await idOfProject(eventId, `Owner ${n}`);
      const b = await idOfProject(eventId, `Other ${n}`);
      await declare(a, gh(`shared-${n}`));
      await withoutTriggers(async (tx) => {
        await tx.execute(
          sql`INSERT INTO project_sources (project_id, source_type, url, position) VALUES (${b}, 'github', ${gh(`shared-${n}`)}, 9)`,
        );
      });
      expect(await problems(eventId)).toEqual([
        {
          kind: 'shared_identity',
          claimKind: 'github',
          value: gh(`shared-${n}`),
          projectIds: [a, b].sort(),
          ownerProjectId: a,
        },
      ]);
    });

    it('a claim still owned by a voided project is reported as such, and the active holder of the identity is reported missing', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const wrong = await idOfProject(eventId, `Wrong ${n}`);
      const right = await idOfProject(eventId, `Right ${n}`);
      await declare(wrong, gh(`corrected-${n}`));
      const actorId = await anActor();
      await withoutTriggers(async (tx) => {
        await tx.execute(
          sql`INSERT INTO project_voids (event_id, project_id, voided_by_actor_id, reason, name_before, idempotency_key, request_hash)
              VALUES (${eventId}, ${wrong}, ${actorId}, 'test', ${`Wrong ${n}`}, ${`k-${n}-12345678`}, ${'a'.repeat(64)})`,
        );
        await tx.execute(
          sql`INSERT INTO project_sources (project_id, source_type, url, position) VALUES (${right}, 'github', ${gh(`corrected-${n}`)}, 9)`,
        );
      });
      const report = await problems(eventId);
      expect(report).toEqual(
        expect.arrayContaining([
          {
            kind: 'claim_owned_by_voided_project',
            claimKind: 'github',
            value: gh(`corrected-${n}`),
            projectIds: [wrong],
          },
          {
            kind: 'missing_claim',
            claimKind: 'github',
            value: gh(`corrected-${n}`),
            projectIds: [right],
          },
        ]),
      );
    });

    it('a claim owned by an active project that does not hold the identity is stale, while the project that does hold it is missing its claim', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const holder = await idOfProject(eventId, `Holder ${n}`);
      const squatter = await idOfProject(eventId, `Squatter ${n}`);
      await withoutTriggers(async (tx) => {
        await tx.execute(
          sql`INSERT INTO project_sources (project_id, source_type, url, position) VALUES (${holder}, 'github', ${gh(`moved-${n}`)}, 9)`,
        );
        await tx.execute(
          sql`INSERT INTO project_submission_claims (event_id, project_id, kind, value) VALUES (${eventId}, ${squatter}, 'github', ${gh(`moved-${n}`)})`,
        );
      });
      expect(await problems(eventId)).toEqual(
        expect.arrayContaining([
          {
            kind: 'stale_claim',
            claimKind: 'github',
            value: gh(`moved-${n}`),
            projectIds: [squatter],
          },
          {
            kind: 'missing_claim',
            claimKind: 'github',
            value: gh(`moved-${n}`),
            projectIds: [holder],
          },
        ]),
      );
    });

    it('a voided project that holds links and a label, with its claims released, produces no problem', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const gone = await idOfProject(eventId, `Gone ${n}`);
      await declare(gone, gh(`gone-${n}`));
      const actorId = await anActor();
      await withoutTriggers(async (tx) => {
        await tx.execute(
          sql`INSERT INTO project_voids (event_id, project_id, voided_by_actor_id, reason, name_before, idempotency_key, request_hash)
              VALUES (${eventId}, ${gone}, ${actorId}, 'test', ${`Gone ${n}`}, ${`g-${n}-12345678`}, ${'b'.repeat(64)})`,
        );
        await tx.execute(sql`DELETE FROM project_submission_claims WHERE project_id = ${gone}`);
      });
      expect(await problems(eventId)).toEqual([]);
    });
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
