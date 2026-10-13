/*
 * R7-13: the documented offline demonstration (docs/DEMO_RUNBOOK.md) must be reproducible from a clean checkout. This test walks the exact
 * path the runbook describes with the real pieces: `pnpm demo:prepare` writes the replay fixture and seeds the labelled synthetic project; the
 * API's runtime gate accepts that fixture file; the worker's runtime loads it from the path in ASSESSMENT_REPLAY_FIXTURE and replays it; the
 * API shows a verified, replay-labelled assessment. No model, no network.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { events, projects, type JudgeDatabase } from '../../packages/database/src/index.js';
import { ReplayFixtureFile } from '../../packages/llm/src/index.js';
import { createLogger } from '../../packages/shared/src/index.js';
import { AssessmentService } from '../../apps/api/src/assessments/service.js';
import { openOfflineGate } from '../../apps/api/src/assessments/runtime-gate.js';
import { buildApp, SERVICE_NAME, type ApiApp } from '../../apps/api/src/app.js';
import { ProjectService } from '../../apps/api/src/projects/service.js';
import { bearer, fakeVerifier, TEST_TOKENS } from '../../apps/api/src/testing/harness.js';
import { createAssessmentRuntime } from '../../apps/worker/src/assessment/runtime.js';
import {
  DEMO_EVENT_NAME,
  DEMO_PROJECT_NAME,
  recordReplayFixture,
  seedDemo,
} from '../../apps/worker/src/testing/demo.js';
import {
  memoryLogger,
  testDatabaseTargets,
  type TestDatabase,
} from '../../apps/worker/src/testing/harness.js';

const ROOT = resolve(import.meta.dirname, '../..');
const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
// the models the API freezes by default (apps/api/src/env.ts): the fixture is recorded for exactly these
const MODELS = {
  extraction: 'claude-haiku-5-5',
  assessment: 'claude-sonnet-5-5',
  critic: 'claude-sonnet-5-5',
} as const;

describe.each(testDatabaseTargets())(
  'the documented offline demonstration on %s',
  (_name, open) => {
    let testDb: TestDatabase;
    let db: JudgeDatabase;
    let app: ApiApp;
    let dir: string;
    let fixturePath: string;

    beforeAll(async () => {
      testDb = await open();
      db = testDb.db;
      dir = mkdtempSync(join(tmpdir(), 'judge-demo-'));
      fixturePath = join(dir, 'replay-fixture.json');
      writeFileSync(fixturePath, `${JSON.stringify(await recordReplayFixture(), null, 2)}\n`);
      const gate = await openOfflineGate({ provider: 'replay', fixturePath, models: MODELS });
      expect(gate).toMatchObject({ problem: null });
      app = buildApp({
        logger,
        db,
        verifier: fakeVerifier(),
        projects: new ProjectService({ db }),
        assessments: new AssessmentService({ db, offline: gate.runtime }),
      });
    });
    afterAll(async () => {
      await app.close();
      await testDb.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('writes a valid, synthetic, hand-written fixture that the API gate accepts', () => {
      const fixture = ReplayFixtureFile.parse(JSON.parse(readFileSync(fixturePath, 'utf8')));
      expect(fixture.synthetic).toBe(true);
      expect(fixture.entries.length).toBeGreaterThan(5);
      expect(
        fixture.entries.every((entry) =>
          /hand-authored by the repository, not produced by any model/.test(entry.note ?? ''),
        ),
      ).toBe(true);
    });

    it('seeds a project that cannot be mistaken for real data', async () => {
      const seeded = await seedDemo(db);
      const [event] = (await db.select().from(events)).filter((row) => row.id === seeded.eventId);
      const [project] = (await db.select().from(projects)).filter(
        (row) => row.id === seeded.projectId,
      );
      expect(event?.name).toBe(DEMO_EVENT_NAME);
      expect(project?.name).toBe(DEMO_PROJECT_NAME);
      expect(DEMO_EVENT_NAME + DEMO_PROJECT_NAME).toMatch(/SYNTHETIC DEMO.*SYNTHETIC DEMO/);
    });

    it('runs the documented path end to end: the worker replays the file named by ASSESSMENT_REPLAY_FIXTURE, the API shows a verified replay demonstration', async () => {
      const seeded = await seedDemo(db);
      const call = (method: 'GET' | 'POST', url: string, key?: string, payload?: unknown) =>
        app.inject({
          method,
          url,
          headers: { ...bearer(TEST_TOKENS.organizer), ...(key ? { 'idempotency-key': key } : {}) },
          ...(payload === undefined ? {} : { payload: payload as object }),
        });
      const requested = await call(
        'POST',
        `/projects/${seeded.projectId}/assessments`,
        '20000000-0000-4000-8000-000000000001',
        { mode: 'assess' },
      );
      expect(requested.statusCode).toBe(202);

      const loop = await createAssessmentRuntime({
        db,
        logger: memoryLogger().logger,
        env: {
          ASSESSMENT_PROVIDER: 'replay',
          ASSESSMENT_REPLAY_FIXTURE: fixturePath,
          ASSESSMENT_CONCURRENCY: 1,
          ASSESSMENT_POLL_INTERVAL_MS: 50,
          ASSESSMENT_LEASE_MS: 60_000,
          ASSESSMENT_PENDING_MAX_AGE_MS: 3_600_000,
          ASSESSMENT_SHUTDOWN_GRACE_MS: 1_000,
          DATABASE_URL: 'postgres://not-used',
          GITHUB_TOKEN: undefined,
        } as never,
      });
      expect(loop).not.toBeNull();
      await loop?.drain();

      const list = (await call('GET', `/projects/${seeded.projectId}/assessments`)).json<{
        assessments: {
          verified: boolean;
          replayDemonstration: boolean;
          overall: { state: string; score10: number };
        }[];
      }>();
      expect(list.assessments).toHaveLength(1);
      expect(list.assessments[0]).toMatchObject({ verified: true, replayDemonstration: true });
      expect(list.assessments[0]?.overall).toMatchObject({ state: 'scored', score10: 7 });
    });
  },
);

describe('pnpm demo:prepare (the command line)', () => {
  const tsx = join(ROOT, 'node_modules/tsx/dist/cli.mjs');
  const cli = join(ROOT, 'apps/worker/src/testing/demo-cli.ts');

  it.skipIf(!existsSync(tsx))('refuses to run in production and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'judge-demo-cli-'));
    const target = join(dir, 'fixture.json');
    const result = spawnSync(
      process.execPath,
      [tsx, '--conditions=@judge-copilot/source', cli, '--fixture', target],
      {
        cwd: ROOT,
        env: { ...process.env, NODE_ENV: 'production' },
        encoding: 'utf8',
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refused in production');
    expect(existsSync(target)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!existsSync(tsx))(
    'writes the fixture to the path it is given, and creates nothing in the checkout',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'judge-demo-cli-'));
      const target = join(dir, 'nested', 'fixture.json');
      const before = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      const result = spawnSync(
        process.execPath,
        [tsx, '--conditions=@judge-copilot/source', cli, '--fixture', target],
        {
          cwd: ROOT,
          env: { ...process.env, NODE_ENV: 'development' },
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(0);
      expect(ReplayFixtureFile.parse(JSON.parse(readFileSync(target, 'utf8'))).synthetic).toBe(
        true,
      );
      expect(result.stdout).toContain('Add --seed');
      expect(
        execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
          cwd: ROOT,
          encoding: 'utf8',
        }),
      ).toBe(before);
      rmSync(dir, { recursive: true, force: true });
    },
  );
});
