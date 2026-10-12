import {
  buildEventReferenceItems,
  collectLimitations,
  EXTRACTION_LIMITATION_CODES,
  buildPassages,
  type Limitation,
} from '@judge-copilot/assessment';
import {
  assessmentRunBudget,
  assessmentRunInputs,
  AssessmentPersistError,
  AssessmentRunError,
  DatabaseRunBudget,
  LockedContextReader,
  type AssessmentInputReader,
  type AssessmentRunStore,
  type AssessmentStore,
  type GraphExtractionStore,
  type JudgeDatabase,
  type StoredExtraction,
} from '@judge-copilot/database';
import {
  costNanoUsd,
  createGuardedProvider,
  inputTokensOf,
  priceFor,
  type Clock,
  type LlmProvider,
  type RetryPolicy,
} from '@judge-copilot/llm';
import type { AssessmentRunFailureCategory, AssessmentRunLimits } from '@judge-copilot/schemas';
import type { Logger } from '@judge-copilot/shared';
import { eq } from 'drizzle-orm';
import { safeErrorCode } from '../capture/safe-error.js';
import { assessUnits } from './assess.js';
import {
  checkPipelineConfig,
  contextConfigHash,
  extractionConfigHash,
  PRICE_TABLES,
  type AssessmentPipelineConfig,
  type EffectivePlan,
} from './config.js';
import { runExtractionStages, type ExtractionDraft } from './extract.js';
import { RecordingBudget } from './ledger.js';
import { ModelCaller } from './model-call.js';
import { preflight } from './preflight.js';
import { RunSession } from './session.js';
import { loadPinnedSources } from './sources.js';
import { cancelRun, failRun, lostRun, RunStopped, safeCode, type Stop } from './stop.js';
import {
  bindExtraction,
  writeContextExtraction,
  writeSourceExtraction,
  type WriteContext,
} from './write-extraction.js';

/*
 * The offline assessment pipeline of ONE run, S0-S14 (design §3.2). This function owns the run from its claim to its terminal state:
 *
 *   S0   claim the pending run (lease token); load the pins it froze; check the configuration describes THIS code and THIS provider
 *   S1   load the pinned snapshots' text, select and window passages, run the deterministic budget PREFLIGHT (spends nothing)
 *   S2-S6 extraction stages (skipped when an equal extraction is already committed)         -> extract.ts
 *   S7   write the source extraction atomically (or reuse it) and the model-free Event-Context extraction; bind both to the run
 *   S8-S13 trusted read, scoring context, candidate sets, assessor, critic, decisions, report -> assess.ts
 *   S14  persist through P4's AssessmentStore, which independently RE-SCORES everything and verifies every call binding
 *
 * Guarantees that hold on every path out of here:
 *   - no assessment row exists unless the run `succeeded` in the same transaction (a failed or cancelled run has none);
 *   - no database transaction is open while a provider is called (every store method is one short transaction, and the model port never
 *     receives a database handle);
 *   - model calls are strictly sequential within the run;
 *   - the lease is heartbeat-renewed throughout; if it is lost, nothing more is written about the run;
 *   - every provider attempt, including each transient retry and each repair re-ask, is reserved in the durable ledger first.
 */

export interface PipelineDeps {
  readonly db: JudgeDatabase;
  readonly runs: AssessmentRunStore;
  readonly extractions: GraphExtractionStore;
  readonly store: AssessmentStore;
  readonly reader: AssessmentInputReader;
  /** The BASE provider (replay or scripted in P5): the guard, retry and timeout wrappers are added here, per run. */
  readonly provider: LlmProvider;
  readonly clock: Clock;
  readonly random: () => number;
  readonly logger: Logger;
  readonly leaseMs: number;
  readonly heartbeatEveryMs?: number;
  readonly retry?: RetryPolicy;
  /** Aborted when the worker is shutting down. */
  readonly shutdown: AbortSignal;
  /** Server-side secret values that must never appear in a prompt. */
  readonly secrets?: readonly string[];
}

export type RunOutcome =
  | {
      readonly kind: 'succeeded';
      readonly assessmentId: string;
      readonly versionNumber: number;
    }
  | {
      readonly kind: 'failed';
      readonly category: AssessmentRunFailureCategory;
      readonly code: string;
      readonly stage: string;
    }
  | { readonly kind: 'cancelled'; readonly code: string; readonly stage: string }
  /** The lease was lost or the run was ended by someone else: this worker wrote nothing more about it. */
  | { readonly kind: 'lost'; readonly stage: string }
  /** Another worker claimed the run first. */
  | { readonly kind: 'not_claimed' };

interface RunFacts {
  readonly projectId: string;
  readonly eventId: string;
  readonly contextVersionId: string;
  readonly lockedContentHash: string;
  readonly declaredTrackKeys: readonly string[];
  readonly targetKind: 'overall' | 'track';
  readonly actorId: string | null;
  readonly config: AssessmentPipelineConfig;
  readonly limits: AssessmentRunLimits;
  readonly prices: (typeof PRICE_TABLES)[string];
}

async function loadFacts(deps: PipelineDeps, runId: string, leaseToken: string): Promise<RunFacts> {
  const run = await deps.runs.getRun(runId);
  if (!run) return lostRun('load_run');
  if (run.state !== 'running' || run.leaseToken !== leaseToken) return lostRun('load_run');
  const [inputs] = await deps.db
    .select()
    .from(assessmentRunInputs)
    .where(eq(assessmentRunInputs.runId, runId));
  const [budget] = await deps.db
    .select()
    .from(assessmentRunBudget)
    .where(eq(assessmentRunBudget.runId, runId));
  if (!inputs || !budget) return failRun('internal_error', 'run_inputs_missing', 'load_run');
  const checked = checkPipelineConfig(inputs.pipelineConfig, {
    providerId: deps.provider.id,
    providerMode: deps.provider.mode,
  });
  if (!checked.ok) return failRun('internal_error', checked.code, 'load_run');
  const prices = PRICE_TABLES[budget.priceTableId];
  if (!prices) return failRun('internal_error', 'price_table_unknown', 'load_run');
  if (inputs.targetKind !== 'overall') {
    // Official track rubrics are not assessed in this milestone (design D9): never merged, never substituted.
    return failRun('domain_validation_failed', 'track_target_not_supported', 'load_run');
  }
  return {
    projectId: run.projectId,
    eventId: run.eventId,
    contextVersionId: inputs.contextVersionId,
    lockedContentHash: inputs.lockedContentHash,
    declaredTrackKeys: [...inputs.declaredTrackKeys],
    targetKind: 'overall',
    actorId: inputs.requestedByActorId,
    config: checked.config,
    limits: {
      maxCalls: budget.maxCalls,
      maxInputTokens: budget.maxInputTokens,
      maxOutputTokens: budget.maxOutputTokens,
      maxCostNanoUsd: budget.maxCostNanoUsd,
      maxReservedInputTokensPerCall: budget.maxReservedInputTokensPerCall,
      runWallClockMs: budget.runWallClockMs,
    },
    prices,
  };
}

/**
 * Claims ONE named run, then runs it (tests and tools that already know the run id; the loop claims with `claimNextRun` and calls
 * `runClaimedAssessment` directly, so a run is never claimed twice).
 */
export async function runAssessment(deps: PipelineDeps, runId: string): Promise<RunOutcome> {
  const leaseToken = await deps.runs.claimRun(runId, deps.leaseMs);
  if (leaseToken === null) return { kind: 'not_claimed' };
  return runClaimedAssessment(deps, runId, leaseToken);
}

/**
 * Runs a run THIS worker already holds the lease of (`claimRun` / `claimNextRun` returned `leaseToken`) to a terminal state, or hands
 * it back if the worker no longer owns it. It performs no claim of its own.
 */
export async function runClaimedAssessment(
  deps: PipelineDeps,
  runId: string,
  leaseToken: string,
): Promise<RunOutcome> {
  const { logger } = deps;
  let session: RunSession | null = null;
  try {
    const facts = await loadFacts(deps, runId, leaseToken);
    session = new RunSession({
      runId,
      leaseToken,
      runs: deps.runs,
      clock: deps.clock,
      leaseMs: deps.leaseMs,
      ...(deps.heartbeatEveryMs === undefined ? {} : { heartbeatEveryMs: deps.heartbeatEveryMs }),
      shutdown: deps.shutdown,
      wallClockMs: facts.limits.runWallClockMs,
      logger,
    });
    session.start();
    return await execute(deps, runId, leaseToken, facts, session);
  } catch (error) {
    const stop: Stop =
      error instanceof RunStopped
        ? error.stop
        : {
            kind: 'fail',
            category: 'internal_error',
            code: 'unexpected_error',
            stage: session?.stage ?? 'start',
          };
    if (!(error instanceof RunStopped)) {
      // Never `err: error`: driver errors embed bound parameters. Only a SQLSTATE leaves this function.
      logger.error({ runId, errorCode: safeErrorCode(error) }, 'assessment run error');
    }
    return await terminate(deps, runId, leaseToken, stop, session);
  } finally {
    await session?.stop();
  }
}

/** Writes the terminal state of a run that ends without an assessment. Never throws for a run this worker no longer owns. */
async function terminate(
  deps: PipelineDeps,
  runId: string,
  leaseToken: string,
  stop: Stop,
  session: RunSession | null,
): Promise<RunOutcome> {
  if (stop.kind === 'lost') return { kind: 'lost', stage: stop.stage };
  // a lost lease overrides whatever stopped the run: the worker may only write about a run it owns
  if (session?.reason === 'lease_lost') return { kind: 'lost', stage: stop.stage };
  const ending = {
    runId,
    leaseToken,
    state: stop.kind === 'fail' ? ('failed' as const) : ('cancelled' as const),
    ...(stop.kind === 'fail' ? { failureCategory: stop.category } : {}),
    stageReached: safeCode(stop.stage),
    providerMode: deps.provider.mode,
  };
  try {
    await deps.runs.finishRun({ ...ending, failureCode: safeCode(stop.code) });
  } catch (error) {
    if (error instanceof AssessmentRunError) return { kind: 'lost', stage: stop.stage };
    deps.logger.error(
      { runId, errorCode: safeErrorCode(error) },
      'could not end an assessment run',
    );
    // The code or stage was refused by the database. The run must not stay `running`: end it with generic, always-valid values.
    try {
      await deps.runs.finishRun({
        ...ending,
        stageReached: 'terminate',
        failureCode: 'termination_code_rejected',
      });
    } catch (second) {
      deps.logger.error(
        { runId, errorCode: safeErrorCode(second) },
        'could not end an assessment run',
      );
      return { kind: 'lost', stage: stop.stage };
    }
  }
  return stop.kind === 'fail'
    ? { kind: 'failed', category: stop.category, code: stop.code, stage: stop.stage }
    : { kind: 'cancelled', code: stop.code, stage: stop.stage };
}

async function execute(
  deps: PipelineDeps,
  runId: string,
  leaseToken: string,
  facts: RunFacts,
  session: RunSession,
): Promise<RunOutcome> {
  const { config, limits, prices } = facts;
  const write: WriteContext = {
    extractions: deps.extractions,
    runs: deps.runs,
    runId,
    leaseToken,
    projectId: facts.projectId,
    eventId: facts.eventId,
    actorId: facts.actorId,
  };

  // -- S0: the pinned context must still be the event's locked version, and must carry an official overall rubric ----------------
  session.checkpoint('pin_check');
  const lockedRead = await new LockedContextReader().read(
    deps.db,
    facts.eventId,
    facts.contextVersionId,
  );
  if (!lockedRead.ok)
    return failRun('internal_error', `context_${lockedRead.failure}`, 'pin_check');
  if (lockedRead.snapshot.status !== 'locked') return cancelRun('context_superseded', 'pin_check');
  if (lockedRead.recomputedHash !== facts.lockedContentHash) {
    return failRun('internal_error', 'context_hash_mismatch', 'pin_check');
  }
  const locked = lockedRead.snapshot;
  const overall = locked.document.rubrics.filter((rubric) => rubric.scope === 'overall');
  if (overall.length !== 1) {
    // No official overall rubric means the fallback rubric would apply, and its anchors are not approved for use (design N12).
    return failRun('domain_validation_failed', 'fallback_anchors_not_approved', 'pin_check');
  }
  const units = overall[0]?.criteria.length ?? 0;
  if (buildEventReferenceItems(locked, facts.declaredTrackKeys).items.length === 0) {
    // P4 contract gap (see the P5 report): a context extraction needs at least one record and the trusted reader requires it. Stop
    // BEFORE any spend rather than after the source extraction has been paid for.
    return failRun('domain_validation_failed', 'no_context_reference_evidence', 'pin_check');
  }

  // -- S1: the pinned text, windowing, and the preflight --------------------------------------------------------------------------
  session.checkpoint('load_sources');
  const sources = await loadPinnedSources(deps.db, runId, facts.projectId);
  const snapshotIds = sources.pins.map((pin) => pin.snapshotId);
  if (buildPassages(sources.artifacts, config.windowing).passages.length === 0) {
    return failRun('source_unavailable', 'no_passages_selected', 'select');
  }
  session.checkpoint('preflight');
  const plan = await preflight({
    artifacts: sources.artifacts,
    budgets: config.windowing,
    units,
    rubric: 'official',
    limits,
    models: config.models,
    prices,
    extractionExists: async (candidate: EffectivePlan) =>
      (await deps.extractions.lookup({
        projectId: facts.projectId,
        kind: 'source',
        configHash: extractionConfigHash(config, candidate),
        snapshotIds,
        contextVersionId: null,
      })) !== null,
  });
  if (!plan.ok) {
    return plan.reason === 'unpriced_model'
      ? failRun('internal_error', 'model_unpriced', 'preflight')
      : failRun('budget_exceeded', 'preflight_plan_exceeds_limits', 'preflight');
  }

  // -- the guarded provider of this run ---------------------------------------------------------------------------------------------
  const ledger = new RecordingBudget(
    new DatabaseRunBudget({
      db: deps.db,
      runId,
      nowMs: () => deps.clock.now(),
      measure: (model, usage) => {
        const price = priceFor(prices, model);
        if (!price) return null;
        const input = inputTokensOf(usage);
        return {
          inputTokens: input,
          outputTokens: usage.outputTokens,
          costNanoUsd: costNanoUsd(price, input, usage.outputTokens),
        };
      },
    }),
  );
  const guarded = createGuardedProvider({
    base: deps.provider,
    budget: ledger,
    prices,
    clock: deps.clock,
    random: deps.random,
    ...(deps.retry === undefined ? {} : { retry: deps.retry }),
  });
  const caller = new ModelCaller({
    session,
    ledger,
    provider: guarded,
    config,
    ...(deps.secrets === undefined ? {} : { secrets: deps.secrets }),
  });

  // -- S2-S7: the source extraction, reused when an equal one is committed ------------------------------------------------------
  const sourceConfig = extractionConfigHash(config, plan.plan);
  let draft: ExtractionDraft | null = null;
  let source: StoredExtraction | null = plan.reused
    ? await deps.extractions.lookup({
        projectId: facts.projectId,
        kind: 'source',
        configHash: sourceConfig,
        snapshotIds,
        contextVersionId: null,
      })
    : null;
  if (source === null) {
    draft = await runExtractionStages({
      caller,
      windowing: plan.windowing,
      plan: plan.plan,
      statuses: sources.statuses,
      limits,
    });
    session.checkpoint('write_source_extraction');
    source = await writeSourceExtraction(write, {
      draft,
      configHash: sourceConfig,
      snapshotIds,
      snapshots: sources.snapshotFacts,
      artifacts: sources.artifacts,
    });
  }
  await bindExtraction(write, 'source', source.id, 'bind_source_extraction');
  session.checkpoint('write_context_extraction');
  const context = await writeContextExtraction(write, {
    locked,
    declaredTrackKeys: facts.declaredTrackKeys,
    configHash: contextConfigHash(config),
  });
  await bindExtraction(write, 'context_evidence', context.id, 'bind_context_extraction');

  // -- S8-S13 ---------------------------------------------------------------------------------------------------------------------
  session.checkpoint('assess');
  const assessed = await assessUnits({ caller, ledger, reader: deps.reader, runId, limits });

  // Extraction-time notices (fidelity downgrades, rejected items, dropped relations) belong to the extraction, so they are read back
  // from it: a reusing run discloses exactly what the original run did (R5 F-5). The windowing and locked-context notices are
  // properties of THIS run's inputs and are always recomputed; the two sets of codes are disjoint.
  const recorded = recordedExtractionLimitations(source);
  const limitations: Limitation[] = [
    ...collectLimitations({ windowing: plan.windowing, locked }),
    ...(recorded ??
      (draft === null
        ? []
        : collectLimitations({
            fidelity: draft.fidelity,
            rejections: draft.rejections,
            droppedRelations: draft.droppedRelations,
          }))),
  ];
  const note = (code: string, subjects: readonly string[]) => {
    limitations.push({
      code,
      count: subjects.length || 1,
      subjects: [...subjects],
    } as unknown as Limitation);
  };
  if (plan.reductionSteps > 0) {
    note('preflight_reduction', [
      `source_budget:${String(plan.plan.budgets.source)}`,
      `claims_cap:${String(plan.plan.claimsCap)}`,
      `evidence_cap:${String(plan.plan.evidenceCap)}`,
    ]);
  }
  if (draft === null) note('extraction_reused', [source.extractionKey]);
  if (draft === null && recorded === null) {
    // an extraction created before its notices were recorded: its fidelity and rejection notices cannot be reproduced, and the judge is told so
    note('extraction_limitations_not_recorded', [source.extractionKey]);
  }
  if (assessed.evaluation.mostlyUnassessable) note('mostly_unassessable', []);
  if (assessed.authorized.data.newerDeclarationsExist) note('newer_declarations_exist', []);
  if (assessed.truncatedCandidates.size > 0) {
    // R5 F-7: the assessor saw only a prefix of these dimensions' candidates; the omitted ones could not be cited
    note('candidates_omitted_for_size', [...assessed.truncatedCandidates.keys()].sort());
  }
  if (assessed.minorFindingUnits.length > 0)
    note('critic_minor_findings', [...assessed.minorFindingUnits].sort());

  // -- S14: persist; the store re-scores independently and verifies every binding ----------------------------------------------
  session.checkpoint('persist');
  let persisted;
  try {
    persisted = await deps.store.persist({
      runId,
      leaseToken,
      actorId: facts.actorId,
      report: assessed.report,
      limitations: limitations.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
      judgments: assessed.judgments,
      providerMode: deps.provider.mode,
      fallbackAnchorsVersion: null,
    });
  } catch (error) {
    if (error instanceof AssessmentPersistError) {
      if (error.code === 'run_not_persistable') {
        const current = await deps.runs.getRun(runId);
        if (current === null || current.state !== 'running' || current.leaseToken !== leaseToken) {
          return lostRun('persist');
        }
      }
      return failRun('internal_error', `persist_${error.code}`, 'persist');
    }
    throw error;
  }
  if (persisted.kind === 'cancelled') {
    // The store cancelled the run itself, in its transaction (design D3): no assessment exists.
    return { kind: 'cancelled', code: persisted.reason, stage: 'persist' };
  }
  return {
    kind: 'succeeded',
    assessmentId: persisted.assessmentId,
    versionNumber: persisted.versionNumber,
  };
}

/** The extraction's recorded limitations when every entry is a known code (else null: treated as not recorded). */
function recordedExtractionLimitations(extraction: StoredExtraction): Limitation[] | null {
  const stored = extraction.recordedLimitations;
  if (stored === null) return null;
  const known = new Set<string>(EXTRACTION_LIMITATION_CODES);
  if (stored.some((entry) => !known.has(entry.code))) return null;
  return stored.map((entry) => ({
    code: entry.code as Limitation['code'],
    count: entry.count,
    subjects: [...entry.subjects],
  }));
}
