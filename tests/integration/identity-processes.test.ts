/*
 * P6B-beta3 (R9-1), INDEPENDENT PROCESSES: the identity invariant must hold when the contenders are separate operating-system processes, each with
 * its own PostgreSQL connection and its own copy of the application code -- not just separate connections inside one test process. Each child holds
 * at its write point, and again after writing (before it commits), until every party has arrived, so each decides on state that does not yet contain
 * the other's rows. PostgreSQL only (PGlite is a single in-process database); skipped without TEST_DATABASE_URL.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actors, projects, type JudgeDatabase } from '../../packages/database/src/index.js';
import { rows as sqlRows, sql } from '../../packages/database/src/testing/databases.js';
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

const databaseUrl = process.env['TEST_DATABASE_URL'];
const ROOT = resolve(import.meta.dirname, '../..');
const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
let counter = 0;
const unique = (): string => (counter += 1).toString(36);
const gh = (name: string) => `https://github.com/synthetic/${name}`;
const dp = (name: string) => `https://devpost.com/software/${name}`;

interface ChildResult {
  id: string;
  pid: number;
  ok: boolean;
  code?: string;
  message?: string;
}

describe.skipIf(!databaseUrl)(
  'identity ownership across independent processes (PostgreSQL)',
  () => {
    let testDb: TestDatabase;
    let db: JudgeDatabase;
    let app: ApiApp;
    let eventContext: EventContextService;
    let actorA = '';
    let actorB = '';

    beforeAll(async () => {
      const target = testDatabaseTargets().find(([name]) => name.startsWith('PostgreSQL'));
      testDb = await requireValue(target)[1]();
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
      for (const token of [TEST_TOKENS.organizer, TEST_TOKENS.secondOrganizer]) {
        await app.inject({ method: 'GET', url: '/events', headers: bearer(token) });
      }
      const rows = await db.select().from(actors);
      actorA = requireValue(rows.find((row) => row.subject === 'organizer-1')).id;
      actorB = requireValue(rows.find((row) => row.subject === 'organizer-2')).id;
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

    /** Starts one process per op at once and returns what each printed. */
    async function race(
      ops: { actorId: string; op: Record<string, unknown> }[],
    ): Promise<ChildResult[]> {
      const syncDir = mkdtempSync(join(tmpdir(), 'judge-identity-'));
      try {
        const runs = ops.map(
          ({ actorId, op }, index) =>
            new Promise<ChildResult>((done, fail) => {
              const child = spawn(
                'pnpm',
                [
                  'exec',
                  'tsx',
                  '--conditions=@judge-copilot/source',
                  'apps/api/src/testing/identity-contender.ts',
                  JSON.stringify({
                    databaseUrl,
                    syncDir,
                    id: String(index),
                    parties: ops.length,
                    holdMs: 2_500,
                    actorId,
                    op,
                  }),
                ],
                { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
              );
              let out = '';
              let err = '';
              child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
              child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
              child.on('close', () => {
                const line = out.trim().split('\n').pop() ?? '';
                try {
                  done(JSON.parse(line) as ChildResult);
                } catch {
                  fail(new Error(`contender ${String(index)} printed no result: ${out} ${err}`));
                }
              });
            }),
        );
        return await Promise.all(runs);
      } finally {
        rmSync(syncDir, { recursive: true, force: true });
      }
    }

    async function violations(eventId: string): Promise<string[]> {
      const found = await sqlRows<{ identity: string }>(
        db,
        sql`
      WITH active AS (
        SELECT p.id, p.name FROM projects p
         WHERE p.event_id = ${eventId} AND NOT EXISTS (SELECT 1 FROM project_voids v WHERE v.project_id = p.id)
      ), holdings AS (
        SELECT a.id AS project_id, s.source_type AS kind, s.url AS value
          FROM active a JOIN project_sources s ON s.project_id = a.id WHERE s.source_type IN ('github', 'devpost')
        UNION SELECT a.id, 'github', ps.github_url FROM active a JOIN project_submissions ps ON ps.project_id = a.id
        UNION SELECT a.id, 'devpost', ps.devpost_url FROM active a JOIN project_submissions ps ON ps.project_id = a.id
        UNION SELECT a.id, 'name', lower(btrim(a.name)) FROM active a
      )
      SELECT kind || ' ' || value AS identity FROM holdings GROUP BY kind, value HAVING count(DISTINCT project_id) > 1`,
      );
      return found.map((row) => row.identity);
    }

    async function legacyProject(eventId: string, label: string): Promise<string> {
      return requireValue(
        (
          await db.insert(projects).values({ eventId, name: label }).returning({ id: projects.id })
        )[0],
      ).id;
    }

    it('legacy source declaration (process 1) versus submission (process 2): different operating-system processes, one owner', async () => {
      for (let round = 0; round < 3; round += 1) {
        const eventId = await lockedEvent();
        const n = unique();
        const legacy = await legacyProject(eventId, `Legacy ${n}`);
        const results = await race([
          {
            actorId: actorA,
            op: { kind: 'addSource', projectId: legacy, sourceType: 'github', url: gh(`pp-${n}`) },
          },
          {
            actorId: actorB,
            op: {
              kind: 'submit',
              eventId,
              githubUrl: gh(`pp-${n}`),
              devpostUrl: dp(`pp-${n}`),
              key: randomUUID(),
            },
          },
        ]);
        expect(new Set(results.map((r) => r.pid)).size).toBe(2); // really two processes
        expect(
          results.every((r) => r.code !== 'UNEXPECTED' && r.code !== 'CRASH'),
          JSON.stringify(results),
        ).toBe(true);
        expect(
          results.filter((r) => r.ok),
          JSON.stringify(results),
        ).toHaveLength(1);
        expect(results.find((r) => !r.ok)?.code).toBe('SUBMISSION_CONFLICT');
        expect(await violations(eventId)).toEqual([]);
      }
    }, 120_000);

    it('two legacy declarations of one link from two processes', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const a = await legacyProject(eventId, `LegacyA ${n}`);
      const b = await legacyProject(eventId, `LegacyB ${n}`);
      const results = await race([
        {
          actorId: actorA,
          op: { kind: 'addSource', projectId: a, sourceType: 'devpost', url: dp(`pl-${n}`) },
        },
        {
          actorId: actorB,
          op: { kind: 'addSource', projectId: b, sourceType: 'devpost', url: dp(`pl-${n}`) },
        },
      ]);
      expect(
        results.filter((r) => r.ok),
        JSON.stringify(results),
      ).toHaveLength(1);
      expect(await violations(eventId)).toEqual([]);
    }, 60_000);

    it('case-colliding labels from two processes (legacy creation versus submission)', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const results = await race([
        { actorId: actorA, op: { kind: 'createProject', eventId, name: `Orbit ${n}` } },
        {
          actorId: actorB,
          op: {
            kind: 'submit',
            eventId,
            githubUrl: gh(`po-${n}`),
            devpostUrl: dp(`po-${n}`),
            name: `ORBIT ${n}`,
            key: randomUUID(),
          },
        },
      ]);
      expect(
        results.filter((r) => r.ok),
        JSON.stringify(results),
      ).toHaveLength(1);
      expect(results.find((r) => !r.ok)?.code).toBe('PROJECT_NAME_TAKEN');
      expect(await violations(eventId)).toEqual([]);
    }, 60_000);

    it('two processes submitting the same pair with the same key: one creation, no duplicate', async () => {
      const eventId = await lockedEvent();
      const n = unique();
      const key = randomUUID();
      const op = {
        kind: 'submit',
        eventId,
        githubUrl: gh(`pk-${n}`),
        devpostUrl: dp(`pk-${n}`),
        key,
      };
      const results = await race([
        { actorId: actorA, op },
        { actorId: actorA, op },
      ]);
      expect(
        results.every((r) => r.ok),
        JSON.stringify(results),
      ).toBe(true);
      const created = await sqlRows<{ n: number }>(
        db,
        sql`SELECT count(*)::int AS n FROM project_submissions WHERE event_id = ${eventId}`,
      );
      expect(created[0]?.n).toBe(1);
      expect(await violations(eventId)).toEqual([]);
    }, 60_000);
  },
);
