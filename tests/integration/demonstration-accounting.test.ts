import { sql } from '../../packages/database/src/testing/databases.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assessmentRunCalls,
  assessmentRunOutcomes,
  type JudgeDatabase,
} from '../../packages/database/src/index.js';
import { ScriptedProvider } from '../../packages/llm/src/index.js';
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
import { demonstrationStep } from '../../apps/worker/src/assessment/demonstration-model.js';
import { execute } from '../../apps/worker/src/testing/run.js';

/*
 * P6D: scripted-demonstration ACCOUNTING through the HTTP API, the stored records and the billing summary (docs/ACCOUNTING.md).
 * Before P6D a scripted run wrote a priced placeholder (about $0.017) into the ledger and the API returned it as the run's cost.
 */

const logger = createLogger({ service: SERVICE_NAME, level: 'silent' });
const MODELS = {
  extraction: 'claude-haiku-5-5',
  assessment: 'claude-sonnet-5-5',
  critic: 'claude-sonnet-5-5',
};
const world = {
  rules: [{ statement: 'Every project must be original work.', certainty: 'explicit' as const }],
};

describe.each(testDatabaseTargets())('scripted demonstration accounting on %s', (_name, open) => {
  let testDb: TestDatabase;
  let db: JudgeDatabase;
  let app: ApiApp;
  beforeAll(async () => {
    testDb = await open();
    db = testDb.db;
    app = buildApp({
      logger,
      db,
      verifier: fakeVerifier(),
      eventContext: replayService(db, (await loadFixtures()).values()),
      projects: new ProjectService({ db }),
      assessments: new AssessmentService({
        db,
        offline: { provider: { id: 'scripted', mode: 'scripted' }, models: MODELS },
      }),
    });
  });
  afterAll(async () => {
    await app.close();
    await testDb.close();
  });

  interface ApiView {
    notice: string;
    assessments: { id: string }[];
    usage: object & {
      simulated: {
        notionalCostNanoUsd: number;
        reportedInputTokens: number;
      };
    };
    notices: { advisory: string; replay: string };
  }

  const get = async (url: string) => {
    const response = await app.inject({
      method: 'GET',
      url,
      headers: bearer(TEST_TOKENS.organizer),
    });
    return response.json<ApiView>();
  };

  it('the demonstrator’s run: zero tokens, zero cost in the ledger, the outcome row AND the API; the stages are counted as stage executions only', async () => {
    const run = await execute(db, {
      provider: new ScriptedProvider([demonstrationStep], { repeatLast: true }),
      worldOptions: world,
    });
    expect(run.outcome.kind).toBe('succeeded');
    const rows = await run.calls();
    expect(rows.length).toBeGreaterThan(5);
    expect(
      rows.reduce(
        (sum, row) =>
          sum + (row.costNanoUsd ?? 0) + (row.inputTokens ?? 0) + (row.outputTokens ?? 0),
        0,
      ),
    ).toBe(0);
    expect(rows.every((row) => row.providerMode === 'scripted')).toBe(true);
    // the billing summary (terminal outcome row)
    const [summary] = (await db.select().from(assessmentRunOutcomes)).filter(
      (row) => row.runId === run.runId,
    );
    expect(summary).toMatchObject({ outcome: 'succeeded', providerMode: 'scripted' });
    expect([summary?.inputTokens, summary?.outputTokens, summary?.costNanoUsd]).toEqual([0, 0, 0]);

    const projectId = run.world.project.id;
    const list = await get(`/projects/${projectId}/assessments`);
    const assessmentId = list.assessments[0]?.id;
    const detail = await get(`/projects/${projectId}/assessments/${assessmentId}`);
    const runView = await get(`/projects/${projectId}/assessment-runs/${run.runId}`);
    for (const usage of [detail.usage, runView.usage]) {
      expect(usage).toMatchObject({
        basis: 'simulated',
        stageExecutions: rows.length,
        providerCalls: 0,
        attemptsStarted: 0,
        settledCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costNanoUsd: 0,
        simulated: {
          stageExecutions: rows.length,
          reportedInputTokens: 0,
          reportedOutputTokens: 0,
          notionalCostNanoUsd: 0,
        },
      });
    }
    // the serialized response contains no cost anywhere
    expect(JSON.stringify(detail)).not.toMatch(/"costNanoUsd":[1-9]/);
  });

  it('M6 phase 0 (R8B P3-4): the outcome row says in its own columns that a demonstration executed local stages and made NO provider call', async () => {
    const run = await execute(db, {
      provider: new ScriptedProvider([demonstrationStep], { repeatLast: true }),
      worldOptions: world,
    });
    const rows = await run.calls();
    const [summary] = (await db.select().from(assessmentRunOutcomes)).filter(
      (row) => row.runId === run.runId,
    );
    // the historical ledger counters keep their meaning (ledger entries = local stage executions) ...
    expect(summary?.attemptsStarted).toBe(rows.length);
    // ... and the explicit columns separate the two things that must never be confused
    expect(summary?.stageExecutions).toBe(rows.length);
    expect(summary?.providerCalls).toBe(0);
    expect(summary?.providerMode).toBe('scripted');
    // the database refuses a non-live outcome that claims provider calls, and a stage count that disagrees with the ledger counters
    type Constraint = { conname: string; def: string };
    const constraints = await db.execute<Constraint>(
      sql`select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'assessment_run_outcomes'::regclass`,
    );
    const list: Constraint[] = Array.isArray(constraints)
      ? (constraints as Constraint[])
      : ((constraints as { rows?: Constraint[] }).rows ?? []);
    const live = list.find((c) => c.conname === 'assessment_run_outcomes_provider_calls_live_only');
    expect(live?.def).toMatch(/provider_mode = 'live'/);
    expect(list.map((c) => c.conname)).toContain('assessment_run_outcomes_stage_executions_match');
  });

  it('a record written BEFORE P6D (a priced placeholder in a scripted run) is reinterpreted, never rewritten: actual cost 0, the old figure kept as a labelled diagnostic', async () => {
    // the default test model reports positive usage, exactly as the pre-P6D demonstrator did
    const run = await execute(db, { worldOptions: world });
    expect(run.outcome.kind).toBe('succeeded');
    const rows = await run.calls();
    const storedCost = rows.reduce((sum, row) => sum + (row.costNanoUsd ?? 0), 0);
    expect(storedCost).toBeGreaterThan(0); // the stored rows are untouched and still say so
    const projectId = run.world.project.id;
    const [listed] = (await get(`/projects/${projectId}/assessments`)).assessments;
    const detail = await get(`/projects/${projectId}/assessments/${listed?.id}`);
    expect(detail.usage).toMatchObject({
      basis: 'simulated',
      providerCalls: 0,
      costNanoUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(detail.usage.simulated.notionalCostNanoUsd).toBe(storedCost);
    expect(detail.usage.simulated.reportedInputTokens).toBeGreaterThan(0);
    // and the stored ledger is byte-for-byte what it was
    const after = (await db.select().from(assessmentRunCalls)).filter(
      (row) => row.runId === run.runId,
    );
    expect(after.map((row) => [row.seq, row.costNanoUsd, row.inputTokens])).toEqual(
      rows.map((row) => [row.seq, row.costNanoUsd, row.inputTokens]),
    );
  });

  it('explicitly synthetic fixtures still trip the spend guards (the ledger is the same code path for every provider)', async () => {
    const run = await execute(db, { limits: { maxCalls: 5 }, worldOptions: world });
    expect(run.outcome).toMatchObject({ kind: 'failed', category: 'budget_exceeded' });
    expect(await run.calls()).toHaveLength(0);
  });

  it('no advisory line of a demonstration says "AI estimate", in the list, the detail or the API notice', async () => {
    const run = await execute(db, {
      provider: new ScriptedProvider([demonstrationStep], { repeatLast: true }),
      worldOptions: world,
    });
    const projectId = run.world.project.id;
    const list = await get(`/projects/${projectId}/assessments`);
    expect(list.notice).toMatch(/^Offline demonstration, not an AI estimate/);
    const detail = await get(`/projects/${projectId}/assessments/${list.assessments[0]?.id}`);
    expect(detail.notices.advisory).toMatch(/^Offline demonstration, not an AI estimate/);
    for (const text of [list.notice, detail.notices.advisory, detail.notices.replay]) {
      expect(text).not.toMatch(/^AI estimate/);
    }
  });
});
