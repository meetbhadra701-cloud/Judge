/*
 * Test-only: seeds a world, requests a run through the run store and executes it with the real pipeline, so each test states only what
 * is special about its scenario. Excluded from the build.
 */
import {
  assessmentRunCalls,
  assessmentRunOutcomes,
  preInterviewAssessments,
  analysisRuns,
  type JudgeDatabase,
} from '@judge-copilot/database';
import { ScriptedProvider, type LlmProvider } from '@judge-copilot/llm';
import type { AssessmentRunLimits } from '@judge-copilot/schemas';
import { eq } from 'drizzle-orm';
import { runAssessment, type PipelineDeps } from '../assessment/pipeline.js';
import {
  harness,
  requestRun,
  seedWorld,
  testConfig,
  type Harness,
  type World,
  type WorldOptions,
} from './assessment-world.js';
import { FakeModel } from './fake-model.js';
import { countTransactions, ProbeProvider } from './probes.js';

export interface Scenario {
  readonly world?: World;
  readonly worldOptions?: WorldOptions;
  readonly model?: FakeModel;
  readonly limits?: Partial<AssessmentRunLimits>;
  /** Replaces the provider the pipeline sees (it receives the scripted provider that serves the model). */
  readonly wrap?: (provider: LlmProvider) => LlmProvider;
  readonly deps?: Partial<PipelineDeps>;
  readonly models?: Partial<Parameters<typeof testConfig>[1]>;
  readonly mode?: 'assess' | 'reassess';
  /** Serves the pipeline from this provider instead of the scripted fake model (for example a ReplayProvider). */
  readonly provider?: LlmProvider;
}

export async function execute(db: JudgeDatabase, scenario: Scenario = {}) {
  const world = scenario.world ?? (await seedWorld(db, scenario.worldOptions ?? {}));
  const model = scenario.model ?? new FakeModel();
  const scripted = scenario.provider ?? new ScriptedProvider([model.step], { repeatLast: true });
  const counting = countTransactions(db);
  const probe = new ProbeProvider(
    scenario.wrap ? scenario.wrap(scripted) : scripted,
    counting.open,
  );
  const h: Harness = harness(counting.db);
  const runId = await requestRun(h, world, probe, {
    ...(scenario.limits === undefined ? {} : { limits: scenario.limits }),
    ...(scenario.models === undefined ? {} : { config: testConfig(probe, scenario.models) }),
    ...(scenario.mode === undefined ? {} : { mode: scenario.mode }),
  });
  const outcome = await runAssessment(h.deps(probe, scenario.deps), runId);
  return {
    world,
    model,
    scripted,
    probe,
    counting,
    h,
    runId,
    outcome,
    calls: () => db.select().from(assessmentRunCalls).where(eq(assessmentRunCalls.runId, runId)),
    run: async () => (await db.select().from(analysisRuns).where(eq(analysisRuns.id, runId)))[0],
    outcomeRow: async () =>
      (
        await db.select().from(assessmentRunOutcomes).where(eq(assessmentRunOutcomes.runId, runId))
      )[0],
    assessments: () =>
      db.select().from(preInterviewAssessments).where(eq(preInterviewAssessments.runId, runId)),
  };
}

export type Executed = Awaited<ReturnType<typeof execute>>;

/** The one fact every failed or cancelled run must satisfy: it left no assessment behind. */
export async function expectNoAssessment(run: Executed, db: JudgeDatabase): Promise<void> {
  const rows = await db
    .select()
    .from(preInterviewAssessments)
    .where(eq(preInterviewAssessments.projectId, run.world.project.id));
  if (rows.length > 0)
    throw new Error(`a non-succeeded run left an assessment (${String(rows.length)})`);
}
