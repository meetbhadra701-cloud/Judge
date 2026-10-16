import {
  assessmentRunCalls,
  AssessmentReadStore,
  preInterviewAssessments,
  type JudgeDatabase,
} from '../../packages/database/src/index.js';
import { ScriptedProvider, type LlmProvider } from '../../packages/llm/src/index.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openOfflineGate } from '../../apps/api/src/assessments/runtime-gate.js';
import { loadApiEnv } from '../../apps/api/src/env.js';
import { loadWorkerEnv } from '../../apps/worker/src/env.js';
import {
  harness,
  requestRun,
  seedWorld,
  TEST_MODELS,
} from '../../apps/worker/src/testing/assessment-world.js';
import {
  memoryLogger,
  testDatabaseTargets,
  type TestDatabase,
} from '../../apps/worker/src/testing/harness.js';
import { execute } from '../../apps/worker/src/testing/run.js';
import { demonstrationStep } from '../../apps/worker/src/assessment/demonstration-model.js';
import { runAssessment } from '../../apps/worker/src/assessment/pipeline.js';
import { createAssessmentRuntime } from '../../apps/worker/src/assessment/runtime.js';

/*
 * P6D: BEHAVIORAL tests of the rule "a demonstration provider (scripted, replay) can never run in production", written so that removing the
 * refusal from ANY single layer fails one of them (the structural scope test only searches for the refusal's message text; R8A showed that
 * leaves the environment layer unpinned). Each layer is tried with the others in their permissive state:
 *
 *   1. environment loaders (API and worker)     2. the API's runtime gate      3. the provider's own constructor
 *   4. the worker runtime, with validation bypassed        5. API/worker disagreement        6. what a scripted run records
 *
 * The real-process version (the built entry points refuse and exit) is tests/integration/demonstration-entrypoints.test.ts.
 */

const DB = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x' } as const;
/** A production API configuration that is valid in every other respect, so a refusal can only come from the provider. */
const PROD_API = {
  ...DB,
  NODE_ENV: 'production',
  AUTH_MODE: 'jwt',
  AUTH_JWT_ISSUER: 'https://issuer.example',
  AUTH_JWT_AUDIENCE: 'judge',
  AUTH_JWKS_URL: 'https://issuer.example/.well-known/jwks.json',
} as const;
const REFUSAL = /scripted demonstration provider is for development and tests only/i;
const REPLAY_FIXTURE = { ASSESSMENT_REPLAY_FIXTURE: '/fixtures/replay.json' };

describe('layer 1: the environment loaders', () => {
  it('production configurations are valid without a demonstration provider (so every refusal below is caused by the provider alone)', () => {
    expect(loadWorkerEnv({ ...DB, NODE_ENV: 'production' }).ASSESSMENT_PROVIDER).toBe('none');
    expect(loadApiEnv({ ...PROD_API }).ASSESSMENT_PROVIDER).toBe('none');
  });

  it('refuses scripted and replay in production, in the API AND in the worker, with the provider named', () => {
    expect(() =>
      loadWorkerEnv({ ...DB, NODE_ENV: 'production', ASSESSMENT_PROVIDER: 'scripted' }),
    ).toThrow(REFUSAL);
    expect(() => loadApiEnv({ ...PROD_API, ASSESSMENT_PROVIDER: 'scripted' })).toThrow(REFUSAL);
    for (const load of [
      () =>
        loadWorkerEnv({
          ...DB,
          ...REPLAY_FIXTURE,
          NODE_ENV: 'production',
          ASSESSMENT_PROVIDER: 'replay',
        }),
      () => loadApiEnv({ ...PROD_API, ...REPLAY_FIXTURE, ASSESSMENT_PROVIDER: 'replay' }),
    ]) {
      expect(load).toThrow(/ASSESSMENT_PROVIDER/);
    }
  });

  it.each([
    'Production',
    'PRODUCTION',
    'prod',
    'staging',
    'live',
    ' production',
    'production ',
    '   ',
  ])(
    'a NODE_ENV that is set but unrecognized (%j) never enables a demonstration provider',
    (nodeEnv) => {
      for (const provider of ['scripted', 'replay']) {
        const extra = provider === 'replay' ? REPLAY_FIXTURE : {};
        expect(() =>
          loadWorkerEnv({ ...DB, ...extra, NODE_ENV: nodeEnv, ASSESSMENT_PROVIDER: provider }),
        ).toThrow();
        expect(() =>
          loadApiEnv({ ...DB, ...extra, NODE_ENV: nodeEnv, ASSESSMENT_PROVIDER: provider }),
        ).toThrow();
      }
    },
  );

  it.each([undefined, ''])(
    'an UNSET or empty NODE_ENV (%j) does not enable a demonstration provider either: it must be set explicitly (P6D)',
    (nodeEnv) => {
      const source = (provider: string, extra: Record<string, string> = {}) => ({
        ...DB,
        ...extra,
        ASSESSMENT_PROVIDER: provider,
        ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }),
      });
      for (const [provider, extra] of [
        ['scripted', {}],
        ['replay', REPLAY_FIXTURE],
      ] as const) {
        expect(() => loadWorkerEnv(source(provider, extra))).toThrow(
          /requires NODE_ENV to be set explicitly/,
        );
        expect(() => loadApiEnv(source(provider, extra))).toThrow(
          /requires NODE_ENV to be set explicitly/,
        );
      }
      // the same unset NODE_ENV is still fine for everything that is not a demonstration (the deployment contract is unchanged)
      expect(
        loadWorkerEnv({ ...DB, ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }) }).NODE_ENV,
      ).toBe('development');
      expect(
        loadApiEnv({ ...DB, ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }) })
          .ASSESSMENT_PROVIDER,
      ).toBe('none');
    },
  );

  it('an explicitly development or test environment accepts scripted, and only then', () => {
    for (const nodeEnv of ['development', 'test']) {
      expect(
        loadWorkerEnv({ ...DB, NODE_ENV: nodeEnv, ASSESSMENT_PROVIDER: 'scripted' })
          .ASSESSMENT_PROVIDER,
      ).toBe('scripted');
      expect(
        loadApiEnv({ ...DB, NODE_ENV: nodeEnv, ASSESSMENT_PROVIDER: 'scripted' })
          .ASSESSMENT_PROVIDER,
      ).toBe('scripted');
    }
  });

  it.each([
    'Scripted',
    'SCRIPTED',
    ' scripted',
    'scripted ',
    'live',
    'anthropic',
    'true',
    '1',
    'demo',
  ])(
    'an invalid provider value (%j) is an error, never a silent fallback to a demonstration provider',
    (value) => {
      expect(() =>
        loadWorkerEnv({ ...DB, NODE_ENV: 'development', ASSESSMENT_PROVIDER: value }),
      ).toThrow();
      expect(() =>
        loadApiEnv({ ...DB, NODE_ENV: 'development', ASSESSMENT_PROVIDER: value }),
      ).toThrow();
    },
  );

  it('an unrelated invalid setting fails the whole configuration instead of defaulting around it', () => {
    expect(() =>
      loadWorkerEnv({
        ...DB,
        NODE_ENV: 'development',
        ASSESSMENT_PROVIDER: 'scripted',
        ASSESSMENT_CONCURRENCY: '99',
      }),
    ).toThrow();
    expect(() =>
      loadApiEnv({
        ...DB,
        NODE_ENV: 'development',
        ASSESSMENT_PROVIDER: 'scripted',
        AUTH_MODE: 'bogus',
      }),
    ).toThrow();
  });
});

describe('layers 2-4: the runtime gate, the provider and the worker runtime hold even when the environment loaders are bypassed', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(['production', 'staging', 'Production', 'prod', ''])(
    'the API runtime gate refuses scripted and replay when the PROCESS environment is %j',
    async (nodeEnv) => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      for (const provider of ['scripted', 'replay'] as const) {
        const gate = await openOfflineGate({
          provider,
          fixturePath: '/fixtures/replay.json',
          models: TEST_MODELS,
        });
        expect(gate.runtime, provider).toBeNull();
        expect(gate.problem, provider).toMatch(/refused/);
      }
    },
  );

  it('the gate opens for scripted only in development and test', async () => {
    for (const nodeEnv of ['development', 'test']) {
      vi.stubEnv('NODE_ENV', nodeEnv);
      const gate = await openOfflineGate({
        provider: 'scripted',
        fixturePath: undefined,
        models: TEST_MODELS,
      });
      expect(gate.problem).toBeNull();
      expect(gate.runtime?.provider).toEqual({ id: 'scripted', mode: 'scripted' });
    }
  });

  it('the provider constructor refuses in production and a caller-supplied environment name can only tighten it', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => new ScriptedProvider([demonstrationStep], { repeatLast: true })).toThrow(
      /refused/,
    );
    expect(
      () => new ScriptedProvider([demonstrationStep], { repeatLast: true, nodeEnv: 'test' }),
    ).toThrow(/refused/);
    vi.stubEnv('NODE_ENV', 'test');
    expect(
      () => new ScriptedProvider([demonstrationStep], { repeatLast: true, nodeEnv: 'production' }),
    ).toThrow(/refused/);
  });

  it('the worker runtime refuses to build the scripted provider in production even when environment validation is bypassed with a hand-made env', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const handMade = {
      ASSESSMENT_PROVIDER: 'scripted',
      ASSESSMENT_CONCURRENCY: 1,
      ASSESSMENT_POLL_INTERVAL_MS: 1000,
      ASSESSMENT_LEASE_MS: 60_000,
      ASSESSMENT_PENDING_MAX_AGE_MS: 900_000,
      ASSESSMENT_SHUTDOWN_GRACE_MS: 10,
    } as unknown as Parameters<typeof createAssessmentRuntime>[0]['env'];
    await expect(
      createAssessmentRuntime({
        db: {} as JudgeDatabase,
        env: handMade,
        logger: memoryLogger().logger,
      }),
    ).rejects.toThrow(/refused|production/);
  });
});

describe.each(testDatabaseTargets())(
  'layers 5-6: API/worker disagreement and what a scripted run records, on %s',
  (_name, open) => {
    let database: TestDatabase;
    let db: JudgeDatabase;
    beforeAll(async () => {
      database = await open();
      db = database.db;
    });
    afterAll(async () => {
      await database.close();
    });

    const refusingProvider = (id: string, mode: LlmProvider['mode']): LlmProvider =>
      ({
        id,
        mode,
        complete: () => {
          throw new Error('the provider must not be called');
        },
      }) as unknown as LlmProvider;

    const worldOptions = {
      rules: [{ statement: 'Must be original.', certainty: 'explicit' as const }],
    };

    it('a run frozen by a SCRIPTED API is refused by a worker holding a replay provider: no assessment, no ledger row', async () => {
      const world = await seedWorld(db, worldOptions);
      const h = harness(db);
      const runId = await requestRun(
        h,
        world,
        new ScriptedProvider([demonstrationStep], { repeatLast: true }),
      );
      for (const wrong of [
        refusingProvider('replay', 'replay'),
        refusingProvider('scripted', 'replay'),
        refusingProvider('scripted', 'live'),
      ]) {
        const outcome = await runAssessment(h.deps(wrong), runId);
        expect(outcome.kind).not.toBe('succeeded');
      }
      expect(
        (await db.select().from(preInterviewAssessments)).filter((a) => a.runId === runId),
      ).toHaveLength(0);
      expect(
        (await db.select().from(assessmentRunCalls)).filter((c) => c.runId === runId),
      ).toHaveLength(0);
    });

    it('a run frozen for REPLAY is refused by a worker that runs the scripted provider (the reverse disagreement)', async () => {
      const world = await seedWorld(db, worldOptions);
      const h = harness(db);
      const runId = await requestRun(h, world, { id: 'replay', mode: 'replay' });
      const outcome = await runAssessment(
        h.deps(new ScriptedProvider([demonstrationStep], { repeatLast: true })),
        runId,
      );
      expect(outcome.kind).toBe('failed');
      expect(
        (await db.select().from(preInterviewAssessments)).filter((a) => a.runId === runId),
      ).toHaveLength(0);
      expect(
        (await db.select().from(assessmentRunCalls)).filter((c) => c.runId === runId),
      ).toHaveLength(0);
    });

    it('a scripted demonstration records zero tokens and zero cost, and is never represented as provider calls or spend (P6D accounting)', async () => {
      const run = await execute(db, {
        provider: new ScriptedProvider([demonstrationStep], { repeatLast: true }),
        worldOptions,
      });
      expect(run.outcome.kind).toBe('succeeded');
      const calls = await run.calls();
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.inputTokens ?? 0).toBe(0);
        expect(call.outputTokens ?? 0).toBe(0);
        expect(call.costNanoUsd ?? 0).toBe(0);
      }
      const outcomeRow = await run.outcomeRow();
      expect(Number(outcomeRow?.costNanoUsd)).toBe(0);
      expect(Number(outcomeRow?.inputTokens)).toBe(0);
      const [assessment] = await run.assessments();
      const detail = await new AssessmentReadStore(db).getDetail(
        run.world.project.id,
        assessment?.id ?? '',
      );
      expect(detail?.usage).toMatchObject({
        basis: 'simulated',
        providerCalls: 0,
        attemptsStarted: 0,
        settledCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costNanoUsd: 0,
        simulated: {
          stageExecutions: calls.length,
          reportedInputTokens: 0,
          reportedOutputTokens: 0,
          notionalCostNanoUsd: 0,
        },
      });
    });
  },
);
