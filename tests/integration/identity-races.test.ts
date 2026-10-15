/*
 * P6B-beta3 (R9-1): at most ONE active project of an event owns a canonical GitHub link, Devpost link or label, whichever route creates it and
 * however the transactions interleave.
 *
 * R7C found that a legacy source declaration and a submission could race and BOTH commit. Each decided on a plain read of the other's rows, and an
 * uncommitted row is invisible to a concurrent reader, so both saw the identity as free. Here every contender is held (test seams) after its read
 * checks and before its first write until all have arrived, so each one decides on stale state exactly as in the worst real interleaving; then the
 * committed rows are checked against an INDEPENDENT oracle (`ownershipViolations`, plain SQL over projects/sources/submissions, not the registry).
 *
 * On PostgreSQL the contenders are real parallel connections; PGlite runs one transaction at a time, so there the same outcomes must hold serially.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actors,
  type JudgeDatabase,
  projectSources,
  projectSubmissions,
  projectVoids,
  projects,
} from '../../packages/database/src/index.js';
import { sql } from '../../packages/database/src/testing/databases.js';
import { createLogger } from '../../packages/shared/src/index.js';
import { AssessmentService } from '../../apps/api/src/assessments/service.js';
import { buildApp, SERVICE_NAME, type ApiApp } from '../../apps/api/src/app.js';
import type { EventContextService } from '../../apps/api/src/event-context/service.js';
import { SourceIngestionError } from '../../apps/api/src/projects/errors.js';
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
const gh = (name: string) => `https://github.com/synthetic/${name}`;
const dp = (name: string) => `https://devpost.com/software/${name}`;

function barrier(parties: number, waitMs = 2_000) {
  let arrived = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    wait: async () => {
      arrived += 1;
      if (arrived >= parties) release();
      await Promise.race([gate, new Promise<void>((resolve) => setTimeout(resolve, waitMs))]);
    },
    allArrivedTogether: () => arrived >= parties,
  };
}

type Outcome = { ok: true; value: string } | { ok: false; code: string };
const attempt = async (work: () => Promise<string>): Promise<Outcome> => {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof SourceIngestionError) return { ok: false, code: error.code };
    throw error;
  }
};

describe.each(testDatabaseTargets())('identity ownership under concurrency on %s', (name, open) => {
  const parallel = name.startsWith('PostgreSQL');
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
      db,
      verifier: fakeVerifier(),
      eventContext,
      projects: new ProjectService({ db }),
      assessments: new AssessmentService({ db, offline: null }),
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

  /** A service whose every write path is held at its write point until `parties` contenders have arrived. */
  function held(parties: number) {
    const gate = barrier(parties);
    // a contender that is BLOCKED by another's uncommitted row (once the database serializes them) never reaches the second gate: it times out
    const commitGate = barrier(parties, 1_500);
    const service = new ProjectService({
      db: contendersDb,
      beforeSubmissionWrite: gate.wait,
      beforeLegacyWrite: gate.wait,
      afterSubmissionWrite: commitGate.wait,
      afterLegacyWrite: commitGate.wait,
    });
    return { service, gate, commitGate };
  }

  /**
   * THE ORACLE. Plain SQL over the base tables, independent of the ownership registry: within an event, no GitHub link, no Devpost link and no
   * case-folded label is held by two ACTIVE (not voided) projects. Returns the offending identities.
   */
  async function ownershipViolations(eventId: string): Promise<string[]> {
    const rows = await db.execute(sql`
      WITH active AS (
        SELECT p.id, p.name FROM projects p
         WHERE p.event_id = ${eventId} AND NOT EXISTS (SELECT 1 FROM project_voids v WHERE v.project_id = p.id)
      ), holdings AS (
        SELECT a.id AS project_id, s.source_type AS kind, s.url AS value
          FROM active a JOIN project_sources s ON s.project_id = a.id WHERE s.source_type IN ('github', 'devpost')
        UNION
        SELECT a.id, 'github', ps.github_url FROM active a JOIN project_submissions ps ON ps.project_id = a.id
        UNION
        SELECT a.id, 'devpost', ps.devpost_url FROM active a JOIN project_submissions ps ON ps.project_id = a.id
        UNION
        SELECT a.id, 'name', lower(btrim(a.name)) FROM active a
      )
      SELECT kind || ' ' || value AS identity, count(DISTINCT project_id)::int AS owners
        FROM holdings GROUP BY kind, value HAVING count(DISTINCT project_id) > 1`);
    const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as {
      identity: string;
    }[];
    return list.map((row) => row.identity);
  }

  async function legacyProject(eventId: string, label: string): Promise<string> {
    return requireValue(
      (
        await db.insert(projects).values({ eventId, name: label }).returning({ id: projects.id })
      )[0],
    ).id;
  }

  const submitVia = (
    service: ProjectService,
    eventId: string,
    actorId: string,
    github: string,
    devpost: string,
    label?: string,
  ) =>
    attempt(
      async () =>
        (
          await service.submitProject(
            eventId,
            { githubUrl: github, devpostUrl: devpost, ...(label ? { name: label } : {}) },
            actorId,
            randomUUID(),
          )
        ).project.id,
    );

  it('legacy source declaration versus submission of the same GitHub link: exactly one owner', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const legacy = await legacyProject(eventId, `Legacy ${n}`);
    const { service, gate } = held(2);
    const outcomes = await Promise.all([
      attempt(
        async () =>
          (
            await service.addSource(
              legacy,
              { sourceType: 'github', url: gh(`lr-${n}`) },
              organizerOne,
            )
          ).id,
      ),
      submitVia(service, eventId, organizerTwo, gh(`lr-${n}`), dp(`lr-${n}`)),
    ]);
    if (parallel) expect(gate.allArrivedTogether()).toBe(true);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toEqual([{ ok: false, code: 'SUBMISSION_CONFLICT' }]);
    expect(await ownershipViolations(eventId)).toEqual([]);
  });

  it('legacy source declaration versus submission of the same DEVPOST link', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const legacy = await legacyProject(eventId, `Legacy ${n}`);
    const { service } = held(2);
    const outcomes = await Promise.all([
      attempt(
        async () =>
          (
            await service.addSource(
              legacy,
              { sourceType: 'devpost', url: dp(`ld-${n}`) },
              organizerOne,
            )
          ).id,
      ),
      submitVia(service, eventId, organizerTwo, gh(`ld-${n}`), dp(`ld-${n}`)),
    ]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(await ownershipViolations(eventId)).toEqual([]);
  });

  it('two legacy declarations of one link on two different projects: exactly one owner', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const a = await legacyProject(eventId, `LegacyA ${n}`);
    const b = await legacyProject(eventId, `LegacyB ${n}`);
    const { service } = held(2);
    const outcomes = await Promise.all([
      attempt(
        async () =>
          (await service.addSource(a, { sourceType: 'github', url: gh(`ll-${n}`) }, organizerOne))
            .id,
      ),
      attempt(
        async () =>
          (await service.addSource(b, { sourceType: 'github', url: gh(`ll-${n}`) }, organizerTwo))
            .id,
      ),
    ]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toEqual([{ ok: false, code: 'SUBMISSION_CONFLICT' }]);
    expect(await ownershipViolations(eventId)).toEqual([]);
  });

  it('the same URL with different project names (legacy versus submission) is still one identity', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const legacy = await legacyProject(eventId, `Completely different name ${n}`);
    const { service } = held(2);
    const outcomes = await Promise.all([
      attempt(
        async () =>
          (
            await service.addSource(
              legacy,
              { sourceType: 'github', url: gh(`ln-${n}`) },
              organizerOne,
            )
          ).id,
      ),
      submitVia(service, eventId, organizerTwo, gh(`ln-${n}`), dp(`ln-${n}`), `Another label ${n}`),
    ]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(await ownershipViolations(eventId)).toEqual([]);
  });

  it('case-colliding labels: a legacy project creation versus a submission naming itself the same label ignoring case', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const { service } = held(2);
    const outcomes = await Promise.all([
      attempt(
        async () => (await service.createProject(eventId, { name: `Orbit ${n}` }, organizerOne)).id,
      ),
      submitVia(service, eventId, organizerTwo, gh(`lc-${n}`), dp(`lc-${n}`), `ORBIT ${n}`),
    ]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toEqual([{ ok: false, code: 'PROJECT_NAME_TAKEN' }]);
    expect(await ownershipViolations(eventId)).toEqual([]);
  });

  it('two legacy project creations whose labels differ only by case', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const { service } = held(2);
    const outcomes = await Promise.all([
      attempt(
        async () => (await service.createProject(eventId, { name: `Nova ${n}` }, organizerOne)).id,
      ),
      attempt(
        async () => (await service.createProject(eventId, { name: `NOVA ${n}` }, organizerTwo)).id,
      ),
    ]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(await ownershipViolations(eventId)).toEqual([]);
  });

  it('a correction that releases a pair versus a plain submission of that pair: one owner afterwards', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const first = await new ProjectService({ db }).submitProject(
      eventId,
      { githubUrl: gh(`cr-${n}`), devpostUrl: dp(`cr-${n}`) },
      organizerOne,
      randomUUID(),
    );
    const done = await (await import('../../apps/worker/src/testing/harness.js')).captureSetup(db);
    await done.loop.drain();
    const { service } = held(2);
    const outcomes = await Promise.all([
      attempt(
        async () =>
          (
            await service.voidProject(
              first.project.id,
              {
                reason: 'wrong',
                replacement: { githubUrl: gh(`cr-${n}`), devpostUrl: dp(`cr-new-${n}`) },
              },
              organizerOne,
              randomUUID(),
            )
          ).replacement?.project.id ?? '',
      ),
      submitVia(service, eventId, organizerTwo, gh(`cr-${n}`), dp(`cr-other-${n}`)),
    ]);
    // whichever is serialized first: the other either conflicts or (after the void released the link) is refused for the replacement's claim
    expect(await ownershipViolations(eventId)).toEqual([]);
    expect(outcomes.some((o) => o.ok)).toBe(true);
  });

  it('a void versus a source declaration on the same project: the voided project never gains a source after the void', async () => {
    for (let round = 0; round < 3; round += 1) {
      const eventId = await lockedEvent();
      const n = unique();
      const legacy = await legacyProject(eventId, `VoidMe ${n}`);
      const { service } = held(2);
      const outcomes = await Promise.all([
        attempt(
          async () =>
            (await service.voidProject(legacy, { reason: 'race' }, organizerOne, randomUUID()))
              .project.id,
        ),
        attempt(
          async () =>
            (
              await service.addSource(
                legacy,
                { sourceType: 'github', url: gh(`vs-${n}`) },
                organizerTwo,
              )
            ).id,
        ),
      ]);
      expect(outcomes.some((o) => o.ok)).toBe(true);
      const voided = (await db.select().from(projectVoids)).some((v) => v.projectId === legacy);
      const sources = (await db.select().from(projectSources)).filter(
        (s) => s.projectId === legacy,
      );
      const claims = await db.execute(
        sql`SELECT count(*)::int AS n FROM project_submission_claims WHERE project_id = ${legacy}`,
      );
      const claimCount = (
        (Array.isArray(claims) ? claims : (claims as { rows: { n: number }[] }).rows)[0] as {
          n: number;
        }
      ).n;
      // a voided project holds no claim, whether its source was declared just before the void or refused
      if (voided) expect(claimCount).toBe(0);
      if (voided && sources.length > 0) {
        const sourceTime = requireValue(sources[0]).createdAt.getTime();
        const voidTime = requireValue(
          (await db.select().from(projectVoids)).find((v) => v.projectId === legacy),
        ).createdAt.getTime();
        expect(sourceTime).toBeLessThanOrEqual(voidTime);
      }
      expect(await ownershipViolations(eventId)).toEqual([]);
    }
  });

  it('the same identity in ANOTHER event is independent, concurrently', async () => {
    const one = await lockedEvent();
    const two = await lockedEvent();
    const n = unique();
    const { service } = held(2);
    const outcomes = await Promise.all([
      submitVia(service, one, organizerOne, gh(`ev-${n}`), dp(`ev-${n}`)),
      submitVia(service, two, organizerTwo, gh(`ev-${n}`), dp(`ev-${n}`)),
    ]);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(await ownershipViolations(one)).toEqual([]);
    expect(await ownershipViolations(two)).toEqual([]);
  });

  it('a loser retried with the same key after the winner is voided succeeds exactly once (lost responses and idempotent retries)', async () => {
    const eventId = await lockedEvent();
    const n = unique();
    const legacy = await legacyProject(eventId, `Winner ${n}`);
    const { service } = held(2);
    const key = randomUUID();
    const outcomes = await Promise.all([
      attempt(
        async () =>
          (
            await service.addSource(
              legacy,
              { sourceType: 'github', url: gh(`rt-${n}`) },
              organizerOne,
            )
          ).id,
      ),
      attempt(
        async () =>
          (
            await service.submitProject(
              eventId,
              { githubUrl: gh(`rt-${n}`), devpostUrl: dp(`rt-${n}`) },
              organizerTwo,
              key,
            )
          ).project.id,
      ),
    ]);
    if (outcomes[1].ok) return; // the submission won this time: nothing further to prove
    // the legacy source won; the loser's rollback left no idempotency record, so after the winner is voided the SAME key creates the project once
    await new ProjectService({ db }).voidProject(
      legacy,
      { reason: 'wrong link' },
      organizerOne,
      randomUUID(),
    );
    const retried = await submitVia(
      new ProjectService({ db }),
      eventId,
      organizerTwo,
      gh(`rt-${n}`),
      dp(`rt-${n}`),
    );
    expect(retried.ok).toBe(true);
    const again = await new ProjectService({ db }).submitProject(
      eventId,
      { githubUrl: gh(`rt-${n}`), devpostUrl: dp(`rt-${n}`) },
      organizerTwo,
      key,
    );
    expect(['created', 'already_submitted', 'replayed']).toContain(again.result);
    expect(
      (await db.select().from(projectSubmissions)).filter((s) => s.githubUrl === gh(`rt-${n}`)),
    ).toHaveLength(1);
    expect(await ownershipViolations(eventId)).toEqual([]);
  });
});
