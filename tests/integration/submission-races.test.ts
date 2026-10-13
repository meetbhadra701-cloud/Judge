/*
 * P6B-beta1: DETERMINISTIC races for the submission operation. The HTTP tests in submission-intent.test.ts fire requests together and rely on
 * the scheduler to interleave them; on a fast machine one request can finish before the other starts, which proves nothing about the
 * database's constraints. Here every contender is held (by `beforeSubmissionWrite`) after it has finished all its read checks and before it
 * writes, until all contenders have arrived. Each contender therefore decided on stale state, exactly as in the worst real interleaving, and
 * only the database's unique constraints plus the re-evaluation of the loser can keep the stored state coherent.
 *
 * On PostgreSQL the contenders really run in parallel transactions on separate connections, so the barrier is reached by all of them (asserted).
 * PGlite runs a transaction at a time, so the barrier times out and the contenders run one after the other; the same outcomes must hold.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actors,
  assessmentRunBudget,
  assessmentRunCalls,
  preInterviewAssessments,
  projectSources,
  projectSubmissionRequests,
  projectSubmissions,
  projects,
  type JudgeDatabase,
} from '../../packages/database/src/index.js';
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

/** Holds each caller until `parties` have arrived (or `waitMs` has passed, for runtimes that cannot run them together). */
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

type Outcome =
  | { ok: true; result: string; projectId: string }
  | { ok: false; code: string; details: Record<string, unknown> };

describe.each(testDatabaseTargets())(
  'submission races, held at the write point, on %s',
  (name, open) => {
    const parallel = name.startsWith('PostgreSQL');
    let testDb: TestDatabase;
    let db: JudgeDatabase;
    /** The database the contenders use: separate connections on PostgreSQL, the single in-process database on PGlite. */
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
      // resolve (and store) both actors through authenticated calls
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

    interface Contender {
      actorId: string;
      key: string;
      github: string;
      devpost: string;
      name?: string;
    }

    /** Runs the contenders in parallel, each held after its checks and before its first write. */
    async function race(
      eventId: string,
      contenders: Contender[],
      when: 'create' | 'converge' = 'create',
    ) {
      const gate = barrier(contenders.length);
      const service = new ProjectService({ db: contendersDb, beforeSubmissionWrite: gate.wait });
      const outcomes: Outcome[] = await Promise.all(
        contenders.map(async (contender): Promise<Outcome> => {
          try {
            const response = await service.submitProject(
              eventId,
              {
                githubUrl: contender.github,
                devpostUrl: contender.devpost,
                ...(contender.name === undefined ? {} : { name: contender.name }),
              },
              contender.actorId,
              contender.key,
            );
            return { ok: true, result: response.result, projectId: response.project.id };
          } catch (error) {
            if (error instanceof SourceIngestionError) {
              return { ok: false, code: error.code, details: error.details };
            }
            throw error;
          }
        }),
      );
      if (parallel && when === 'create') {
        expect(gate.allArrivedTogether(), 'every contender reached the write point together').toBe(
          true,
        );
      }
      return outcomes;
    }

    async function stored(eventId: string) {
      const projectRows = (await db.select().from(projects)).filter(
        (row) => row.eventId === eventId,
      );
      const ids = new Set(projectRows.map((row) => row.id));
      return {
        projects: projectRows,
        sources: (await db.select().from(projectSources)).filter((row) => ids.has(row.projectId)),
        submissions: (await db.select().from(projectSubmissions)).filter(
          (row) => row.eventId === eventId,
        ),
        requests: (await db.select().from(projectSubmissionRequests)).filter((row) =>
          ids.has(row.projectId),
        ),
      };
    }

    const successes = (outcomes: Outcome[]) => outcomes.filter((o) => o.ok);
    const refusals = (outcomes: Outcome[]) => outcomes.filter((o) => !o.ok);

    it('same GitHub repository, different Devpost pages, decided on stale state: one project, the loser is told which', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const outcomes = await race(eventId, [
        {
          actorId: organizerOne,
          key: randomUUID(),
          github: gh(`rg-${n}`),
          devpost: dp(`rg-${n}-a`),
        },
        {
          actorId: organizerTwo,
          key: randomUUID(),
          github: gh(`rg-${n}`),
          devpost: dp(`rg-${n}-b`),
        },
      ]);
      expect(successes(outcomes)).toHaveLength(1);
      const loser = refusals(outcomes)[0];
      expect(loser).toMatchObject({ ok: false, code: 'SUBMISSION_CONFLICT' });
      // the retry re-evaluated against the winner's committed rows, so it can say WHICH project holds the link
      const winner = successes(outcomes)[0];
      expect(loser?.ok === false ? loser.details : null).toEqual({
        projectIds: [winner?.ok === true ? winner.projectId : ''],
      });
      const rows = await stored(eventId);
      expect(rows.projects).toHaveLength(1);
      expect(rows.sources.map((s) => s.sourceType).sort()).toEqual(['devpost', 'github']);
      expect(rows.submissions).toHaveLength(1);
      expect(rows.requests).toHaveLength(1);
    });

    it('same Devpost page, different GitHub repositories', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const outcomes = await race(eventId, [
        {
          actorId: organizerOne,
          key: randomUUID(),
          github: gh(`rd-${n}-a`),
          devpost: dp(`rd-${n}`),
        },
        {
          actorId: organizerTwo,
          key: randomUUID(),
          github: gh(`rd-${n}-b`),
          devpost: dp(`rd-${n}`),
        },
      ]);
      expect(successes(outcomes)).toHaveLength(1);
      expect(refusals(outcomes)[0]).toMatchObject({ ok: false, code: 'SUBMISSION_CONFLICT' });
      const rows = await stored(eventId);
      expect(rows.projects).toHaveLength(1);
      expect(rows.sources.filter((s) => s.sourceType === 'devpost')).toHaveLength(1);
    });

    it('names that differ only by letter case, different pairs: the database folds them, so only one label exists', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const outcomes = await race(eventId, [
        {
          actorId: organizerOne,
          key: randomUUID(),
          github: gh(`rn-${n}-a`),
          devpost: dp(`rn-${n}-a`),
          name: `Orbit ${n}`,
        },
        {
          actorId: organizerTwo,
          key: randomUUID(),
          github: gh(`rn-${n}-b`),
          devpost: dp(`rn-${n}-b`),
          name: `ORBIT ${n}`,
        },
      ]);
      expect(successes(outcomes)).toHaveLength(1);
      expect(refusals(outcomes)[0]).toMatchObject({ ok: false, code: 'PROJECT_NAME_TAKEN' });
      const rows = await stored(eventId);
      expect(rows.projects.filter((p) => p.name.toLowerCase() === `orbit ${n}`)).toHaveLength(1);
      expect(rows.submissions.map((s) => s.nameKey)).toEqual([`orbit ${n}`]);
    });

    it('the same key used for two different submissions: one is accepted, the other is told the key was reused', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const key = randomUUID();
      const outcomes = await race(eventId, [
        { actorId: organizerOne, key, github: gh(`rk-${n}-a`), devpost: dp(`rk-${n}-a`) },
        { actorId: organizerOne, key, github: gh(`rk-${n}-b`), devpost: dp(`rk-${n}-b`) },
      ]);
      expect(successes(outcomes)).toHaveLength(1);
      expect(refusals(outcomes)[0]).toMatchObject({ ok: false, code: 'IDEMPOTENCY_KEY_REUSED' });
      expect((await stored(eventId)).projects).toHaveLength(1);
    });

    it('the same form sent twice at once (same key, same content): one creation, one replay, one project', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const key = randomUUID();
      const same = { actorId: organizerOne, key, github: gh(`rs-${n}`), devpost: dp(`rs-${n}`) };
      const outcomes = await race(eventId, [same, same, same]);
      expect(refusals(outcomes)).toHaveLength(0);
      expect(outcomes.filter((o) => o.ok && o.result === 'created')).toHaveLength(1);
      expect(outcomes.filter((o) => o.ok && o.result === 'replayed')).toHaveLength(2);
      const rows = await stored(eventId);
      expect(rows.projects).toHaveLength(1);
      expect(rows.requests).toHaveLength(1);
    });

    it('the same pair with different keys at once: one creation, the others converge on it', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const outcomes = await race(eventId, [
        { actorId: organizerOne, key: randomUUID(), github: gh(`rc-${n}`), devpost: dp(`rc-${n}`) },
        { actorId: organizerTwo, key: randomUUID(), github: gh(`rc-${n}`), devpost: dp(`rc-${n}`) },
        { actorId: organizerOne, key: randomUUID(), github: gh(`rc-${n}`), devpost: dp(`rc-${n}`) },
      ]);
      expect(refusals(outcomes)).toHaveLength(0);
      expect(outcomes.filter((o) => o.ok && o.result === 'created')).toHaveLength(1);
      expect(outcomes.filter((o) => o.ok && o.result === 'already_submitted')).toHaveLength(2);
      const rows = await stored(eventId);
      expect(rows.projects).toHaveLength(1);
      expect(rows.requests).toHaveLength(3);
    });

    it('converging on an existing project with one key at once: one request is recorded, the other replays it', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const first = await race(eventId, [
        { actorId: organizerOne, key: randomUUID(), github: gh(`rv-${n}`), devpost: dp(`rv-${n}`) },
      ]);
      expect(first[0]).toMatchObject({ ok: true, result: 'created' });
      const key = randomUUID();
      const again = { actorId: organizerTwo, key, github: gh(`rv-${n}`), devpost: dp(`rv-${n}`) };
      const outcomes = await race(eventId, [again, again], 'converge');
      expect(refusals(outcomes)).toHaveLength(0);
      expect(outcomes.map((o) => (o.ok ? o.result : '')).sort()).toEqual([
        'already_submitted',
        'replayed',
      ]);
      const rows = await stored(eventId);
      expect(rows.projects).toHaveLength(1);
      expect(rows.requests.filter((r) => r.idempotencyKey === key)).toHaveLength(1);
    });

    it('a key written in capitals replays the original: the service folds case itself, whatever the route does', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const service = new ProjectService({ db: contendersDb });
      const key = randomUUID();
      const body = { githubUrl: gh(`rl-${n}`), devpostUrl: dp(`rl-${n}`) };
      const first = await service.submitProject(eventId, body, organizerOne, key);
      const again = await service.submitProject(eventId, body, organizerOne, key.toUpperCase());
      expect([first.result, again.result]).toEqual(['created', 'replayed']);
      expect(again.project.id).toBe(first.project.id);
    });

    it('this file never started a model: no assessment, no ledger row, no run budget exists', async () => {
      expect(await db.select().from(preInterviewAssessments)).toHaveLength(0);
      expect(await db.select().from(assessmentRunCalls)).toHaveLength(0);
      expect(await db.select().from(assessmentRunBudget)).toHaveLength(0);
    });
  },
);
