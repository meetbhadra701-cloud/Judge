import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPLAY_FIXTURE_VERSION, ScriptedProvider } from '@judge-copilot/llm';
import { createLogger } from '@judge-copilot/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkerEnv } from '../env.js';
import { memoryLogger, testDatabaseTargets, type TestDatabase } from '../testing/harness.js';
import { nullSink } from '../testing/probes.js';
import { createAssessmentRuntime } from './runtime.js';

const [[, open]] = testDatabaseTargets() as [[string, () => Promise<TestDatabase>]];

describe('the assessment runtime composition', () => {
  let database: TestDatabase;
  let dir: string;
  beforeAll(async () => {
    database = await open();
    dir = await mkdtemp(join(tmpdir(), 'assessment-runtime-'));
  });
  afterAll(async () => {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  });

  const logger = createLogger({ service: 'test', destination: nullSink() });

  it('is OFF by default: no provider means no loop, so no prompt is ever rendered', async () => {
    const loop = await createAssessmentRuntime({
      db: database.db,
      env: WorkerEnv.parse({}),
      logger,
    });
    expect(loop).toBeNull();
  });

  it('builds the loop over an offline replay fixture, and says plainly that it is not a model assessment', async () => {
    const fixture = join(dir, 'fixtures.json');
    await writeFile(
      fixture,
      JSON.stringify({ version: REPLAY_FIXTURE_VERSION, synthetic: true, entries: [] }),
    );
    const { logger: capture, lines } = memoryLogger();
    const loop = await createAssessmentRuntime({
      db: database.db,
      env: WorkerEnv.parse({ ASSESSMENT_PROVIDER: 'replay', ASSESSMENT_REPLAY_FIXTURE: fixture }),
      logger: capture,
    });
    expect(loop).not.toBeNull();
    expect(loop?.inFlight).toBe(0);
    expect(JSON.stringify(lines)).toContain('not a model assessment');
  });

  it('refuses a fixture that is not synthetic or not well formed', async () => {
    const fixture = join(dir, 'bad.json');
    await writeFile(
      fixture,
      JSON.stringify({ version: REPLAY_FIXTURE_VERSION, synthetic: false, entries: [] }),
    );
    await expect(
      createAssessmentRuntime({
        db: database.db,
        env: WorkerEnv.parse({ ASSESSMENT_PROVIDER: 'replay', ASSESSMENT_REPLAY_FIXTURE: fixture }),
        logger,
      }),
    ).rejects.toThrow();
  });

  it('accepts a provider handed in directly (tests) and ignores the environment selection', async () => {
    const loop = await createAssessmentRuntime({
      db: database.db,
      env: WorkerEnv.parse({}),
      logger,
      provider: new ScriptedProvider([]),
    });
    expect(loop).not.toBeNull();
  });
});
