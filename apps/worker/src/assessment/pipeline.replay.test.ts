import {
  assessmentDimensionJudgments,
  assessmentRunCalls,
  preInterviewAssessments,
  type JudgeDatabase,
} from '@judge-copilot/database';
import {
  computeRequestDigest,
  ProviderNotAllowedError,
  REPLAY_FIXTURE_VERSION,
  ReplayProvider,
  ScriptedProvider,
  type LlmProvider,
  type LlmResult,
} from '@judge-copilot/llm';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEVPOST_TEXT } from '../testing/assessment-world.js';
import { FakeModel } from '../testing/fake-model.js';
import { testDatabaseTargets, type TestDatabase } from '../testing/harness.js';
import { execute, expectNoAssessment } from '../testing/run.js';

interface Entry {
  requestDigest: string;
  stage: string;
  note: string;
  output: unknown;
  usage: { inputTokens: number; outputTokens: number };
}

/** Records the hand-authored answers of the fake model keyed by the digest of the exact request (the replay key). */
function recorder(model: FakeModel, sink: Entry[]): LlmProvider {
  return {
    id: 'replay',
    mode: 'replay',
    generate(request): Promise<LlmResult> {
      const result = model.step(request);
      if (result.ok) {
        sink.push({
          requestDigest: computeRequestDigest(request),
          stage: request.stage,
          note: 'synthetic: hand-authored by the test, not produced by any model',
          output: result.json,
          usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
        });
      }
      return Promise.resolve(result);
    },
  };
}

describe.each(testDatabaseTargets())('offline replay of a recorded run on %s', (_name, open) => {
  let database: TestDatabase;
  let db: JudgeDatabase;
  beforeAll(async () => {
    database = await open();
    db = database.db;
  });
  afterAll(async () => {
    await database.close();
  });

  async function record() {
    const entries: Entry[] = [];
    const recorded = await execute(db, { provider: recorder(new FakeModel(), entries) });
    expect(recorded.outcome.kind).toBe('succeeded');
    return { recorded, fixtures: { version: REPLAY_FIXTURE_VERSION, synthetic: true, entries } };
  }

  it('replays a recording in a fresh world: identical requests and decisions, new ids, badged as replay', async () => {
    const { recorded, fixtures } = await record();
    const replay = new ReplayProvider({ fixtures });
    const replayed = await execute(db, { provider: replay });
    expect(replayed.outcome.kind).toBe('succeeded');
    expect(replay.misses).toEqual([]);

    // identical REQUESTS (T-R4): the same digests, because a prompt is a pure function of handles and text, never of persisted ids
    const digests = async (run: typeof recorded) =>
      (await run.calls()).map((call) => `${call.stage}:${call.requestDigest}`).sort();
    expect(await digests(replayed)).toEqual(await digests(recorded));

    // identical DECISIONS, different persisted identities, therefore different report bytes (no byte-identity is promised across extractions)
    const judge = async (run: typeof recorded) => {
      const [assessment] = await run.assessments();
      const rows = await db
        .select()
        .from(assessmentDimensionJudgments)
        .where(eq(assessmentDimensionJudgments.assessmentId, assessment?.id ?? ''));
      return { assessment, rows: rows.map((r) => [r.dimensionId, r.disposition, r.score]) };
    };
    const a = await judge(recorded);
    const b = await judge(replayed);
    expect(b.rows).toEqual(a.rows);
    expect(b.assessment?.providerMode).toBe('replay');
    expect(b.assessment?.outputHash).not.toBe(a.assessment?.outputHash);
    expect(b.assessment?.graphFingerprint).not.toBe(a.assessment?.graphFingerprint);
    const calls = await db
      .select()
      .from(assessmentRunCalls)
      .where(eq(assessmentRunCalls.runId, replayed.runId));
    expect(calls.every((call) => call.providerMode === 'replay' && call.state === 'settled')).toBe(
      true,
    );
  });

  it('a change to any model-visible byte is a replay miss: the run fails provider_error and persists nothing', async () => {
    const { fixtures } = await record();
    const replay = new ReplayProvider({ fixtures });
    const changed = await execute(db, {
      provider: replay,
      worldOptions: { devpostText: `${DEVPOST_TEXT}One more sentence the recording never saw.\n` },
    });
    expect(changed.outcome).toMatchObject({
      kind: 'failed',
      category: 'provider_error',
      code: 'replay_miss',
    });
    expect(replay.misses).toHaveLength(1);
    await expectNoAssessment(changed, db);
    const rows = await db
      .select()
      .from(preInterviewAssessments)
      .where(eq(preInterviewAssessments.projectId, changed.world.project.id));
    expect(rows).toHaveLength(0);
  });

  it('a different model in the configuration is a different request: replay misses', async () => {
    const { fixtures } = await record();
    const replay = new ReplayProvider({ fixtures });
    const run = await execute(db, {
      provider: replay,
      models: {
        models: {
          extraction: 'claude-sonnet-5-5',
          assessment: 'claude-sonnet-5-5',
          critic: 'claude-sonnet-5-5',
        },
      },
    });
    expect(run.outcome).toMatchObject({ kind: 'failed', code: 'replay_miss' });
  });
});

describe('offline providers are refused outside development and test', () => {
  it('refuses the replay and scripted providers when the runtime environment is production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(() => new ScriptedProvider([])).toThrow(ProviderNotAllowedError);
      expect(
        () =>
          new ReplayProvider({
            fixtures: { version: REPLAY_FIXTURE_VERSION, synthetic: true, entries: [] },
          }),
      ).toThrow(ProviderNotAllowedError);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('accepts only synthetic fixtures', () => {
    expect(
      () =>
        new ReplayProvider({
          fixtures: { version: REPLAY_FIXTURE_VERSION, synthetic: false, entries: [] },
        }),
    ).toThrow();
  });
});
