import {
  buildPassages,
  type SelectionPolicyId,
  type SourceArtifact,
  type WindowingBudgets,
  type WindowingResult,
} from '@judge-copilot/assessment';
import { costNanoUsd, priceFor } from '@judge-copilot/llm';
import type { AssessmentRunLimits, PriceTable } from '@judge-copilot/schemas';
import { ladder, STAGE_BATCH, STRUCTURAL_CAPS, type EffectivePlan } from './config.js';

export { ladder };

/*
 * The deterministic budget PREFLIGHT (design §12.3.3-§12.3.4, owner correction C2). After windowing, the number of calls, tokens and cost
 * of the WHOLE run is projected from the passage counts and the scoring units, BEFORE the first model call. When the projection does not
 * fit the run's limits, a fixed reduction ladder lowers the source budget and then the structural caps; when even the floor does not
 * fit, the run fails `budget_exceeded` having spent nothing. The call limit is never raised to make a plan fit.
 *
 * What this is NOT: it is not a guarantee. The counts of claims, evidence and relations are ESTIMATES from the passage counts (the real
 * numbers are only known after extraction), every token figure is an estimate, and transient provider retries are not planned (they
 * draw on the headroom the plan leaves, and the reservation guard stops them exactly at the limit). The local spending guard remains
 * the only enforcement.
 */

export interface PlanInputs {
  readonly statementPassages: number;
  readonly interpretPassages: number;
  /** Counts the plan assumes (estimated by `projectCounts`, or given explicitly in tests). */
  readonly claims: number;
  readonly evidence: number;
  readonly relations: number;
  readonly units: number;
  readonly rubric: 'official' | 'fallback';
  /** An extraction with the same identity is already committed: only the assessment calls remain. */
  readonly extractionReused: boolean;
}

export interface CallPlan {
  readonly byStage: Readonly<Record<string, number>>;
  /** Calls with no re-run and no repair re-ask. */
  readonly nominal: number;
  /** Allowance for critic-triggered re-runs (assessor + critic): 4 for an official rubric, 16 for the fallback. */
  readonly rerunAllowance: number;
  /** Allowance for repair re-asks: at most 10% of nominal (rounded up). */
  readonly repairAllowance: number;
  readonly planned: number;
}

const ceilDiv = (a: number, b: number): number => (a <= 0 ? 0 : Math.ceil(a / b));

/** Paraphrase share of claims that need a fidelity review (design §12.3.4); model-interpreted evidence is always reviewed. */
const PARAPHRASED_CLAIM_SHARE = 0.4;

/** The design's call arithmetic (§12.3.4), given the item counts. Reproduces the design's sizing table exactly. */
export function plannedCalls(input: PlanInputs): CallPlan {
  const reviewItems = Math.round(input.evidence + PARAPHRASED_CLAIM_SHARE * input.claims);
  const extraction = input.extractionReused
    ? {}
    : {
        claim_extraction: ceilDiv(input.statementPassages, STAGE_BATCH.passagesPerCall),
        evidence_interpretation: ceilDiv(input.interpretPassages, STAGE_BATCH.passagesPerCall),
        fidelity_review: ceilDiv(reviewItems, STAGE_BATCH.fidelityItemsPerCall),
        relation_matching: ceilDiv(input.claims, STAGE_BATCH.claimsPerMatchingCall),
        relation_verification: ceilDiv(input.relations, STAGE_BATCH.pairsPerVerificationCall),
        contradiction_detection: input.claims > 0 ? 1 : 0,
        unknown_identification: input.claims > 0 ? 1 : 0,
      };
  const byStage: Record<string, number> = {
    ...extraction,
    dimension_assessment: input.units,
    critic: input.units,
  };
  const nominal = Object.values(byStage).reduce((sum, calls) => sum + calls, 0);
  const rerunAllowance = input.rubric === 'official' ? 4 : 16;
  const repairAllowance = Math.ceil(0.1 * nominal);
  return {
    byStage,
    nominal,
    rerunAllowance,
    repairAllowance,
    planned: nominal + rerunAllowance + repairAllowance,
  };
}

/** Estimated counts from the passage counts (an ESTIMATE: the real numbers exist only after extraction). */
export function projectCounts(
  statementPassages: number,
  interpretPassages: number,
  caps: { readonly claims: number; readonly evidence: number },
): { claims: number; evidence: number; relations: number } {
  const claims = Math.min(caps.claims, Math.ceil(0.7 * statementPassages));
  const evidence = Math.min(caps.evidence, Math.ceil(0.5 * interpretPassages));
  const relations = Math.min(STRUCTURAL_CAPS.relations, Math.ceil(1.5 * claims));
  return { claims, evidence, relations };
}

// -- Token and cost estimates (clearly estimates; see the file comment) ------------------------------------------------------

export interface ModelNames {
  readonly extraction: string;
  readonly assessment: string;
  readonly critic: string;
}

export interface UsageEstimate {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costNanoUsd: number;
}

export function estimateUsage(
  input: PlanInputs,
  plan: CallPlan,
  models: ModelNames,
  prices: PriceTable,
): UsageEstimate | null {
  const calls = (stage: string): number => plan.byStage[stage] ?? 0;
  const evidenceShown = Math.min(STAGE_BATCH.evidenceShownPerCall, input.evidence + input.claims);
  const candidates = Math.min(60, input.claims + input.evidence);
  const reviewItems = Math.round(input.evidence + PARAPHRASED_CLAIM_SHARE * input.claims);
  const extractionInput =
    calls('claim_extraction') * 1_500 +
    input.statementPassages * 330 +
    calls('evidence_interpretation') * 1_500 +
    input.interpretPassages * 330 +
    calls('fidelity_review') * 1_200 +
    reviewItems * 150 +
    calls('relation_matching') * (1_500 + 60 * evidenceShown) +
    input.claims * 40 +
    calls('relation_verification') * 1_200 +
    input.relations * 180 +
    (calls('contradiction_detection') + calls('unknown_identification')) *
      (1_500 + 40 * input.claims + 60 * evidenceShown);
  const extractionOutput =
    calls('claim_extraction') * 1_500 +
    calls('evidence_interpretation') * 2_000 +
    calls('fidelity_review') * 600 +
    calls('relation_matching') * 800 +
    calls('relation_verification') * 400 +
    (calls('contradiction_detection') + calls('unknown_identification')) * 1_000;
  const assessInput = input.units * (2_000 + 120 * candidates);
  const assessOutput = input.units * 700;
  const criticInput = input.units * (1_500 + 150 * candidates);
  const criticOutput = input.units * 400;
  // allowances run the same kinds of calls again: scale every figure by planned / nominal
  const scale = plan.nominal === 0 ? 1 : plan.planned / plan.nominal;
  const inputTokens = Math.ceil((extractionInput + assessInput + criticInput) * scale);
  const outputTokens = Math.ceil((extractionOutput + assessOutput + criticOutput) * scale);
  const extractionPrice = priceFor(prices, models.extraction);
  const assessPrice = priceFor(prices, models.assessment);
  const criticPrice = priceFor(prices, models.critic);
  if (!extractionPrice || !assessPrice || !criticPrice) return null;
  const cost =
    costNanoUsd(extractionPrice, extractionInput * scale, extractionOutput * scale) +
    costNanoUsd(assessPrice, assessInput * scale, assessOutput * scale) +
    costNanoUsd(criticPrice, criticInput * scale, criticOutput * scale);
  return { inputTokens, outputTokens, costNanoUsd: Math.ceil(cost) };
}

// -- The reduction ladder ------------------------------------------------------------------------------------------------------

export interface PreflightInput {
  readonly artifacts: readonly SourceArtifact[];
  readonly budgets: WindowingBudgets;
  /** The selection policy frozen in the run's configuration. */
  readonly selection?: SelectionPolicyId;
  readonly units: number;
  readonly rubric: 'official' | 'fallback';
  readonly limits: AssessmentRunLimits;
  readonly models: ModelNames;
  readonly prices: PriceTable;
  /** Called with a candidate plan; true when an extraction with that identity is already committed (so only assessment calls remain). */
  readonly extractionExists: (plan: EffectivePlan) => Promise<boolean>;
}

export type PreflightResult =
  | {
      readonly ok: true;
      readonly plan: EffectivePlan;
      readonly windowing: WindowingResult;
      readonly reused: boolean;
      readonly calls: CallPlan;
      readonly estimate: UsageEstimate;
      /** How many ladder steps were needed (0 = the configured budgets fit). */
      readonly reductionSteps: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'plan_exceeds_limits' | 'unpriced_model';
      readonly lastCalls: CallPlan | null;
    };

/**
 * Picks the first step of the ladder whose projected run fits the limits. A step for which an extraction already exists costs only the
 * assessment calls. Pure apart from `extractionExists` (a read-only lookup). Spends nothing.
 */
export async function preflight(input: PreflightInput): Promise<PreflightResult> {
  let lastCalls: CallPlan | null = null;
  for (const plan of ladder(input.budgets)) {
    const windowing = buildPassages(input.artifacts, plan.budgets, input.selection);
    const statementPassages = windowing.passages.filter((p) => p.route === 'statement').length;
    const interpretPassages = windowing.passages.length - statementPassages;
    const counts = projectCounts(statementPassages, interpretPassages, {
      claims: plan.claimsCap,
      evidence: plan.evidenceCap,
    });
    const reused = await input.extractionExists(plan);
    const planInputs: PlanInputs = {
      statementPassages,
      interpretPassages,
      ...counts,
      units: input.units,
      rubric: input.rubric,
      extractionReused: reused,
    };
    const calls = plannedCalls(planInputs);
    lastCalls = calls;
    const estimate = estimateUsage(planInputs, calls, input.models, input.prices);
    if (estimate === null) return { ok: false, reason: 'unpriced_model', lastCalls: calls };
    const fits =
      calls.planned <= input.limits.maxCalls &&
      estimate.inputTokens <= input.limits.maxInputTokens &&
      estimate.outputTokens <= input.limits.maxOutputTokens &&
      estimate.costNanoUsd <= input.limits.maxCostNanoUsd;
    if (fits) {
      return {
        ok: true,
        plan,
        windowing,
        reused,
        calls,
        estimate,
        reductionSteps: plan.step,
      };
    }
  }
  return { ok: false, reason: 'plan_exceeds_limits', lastCalls };
}
