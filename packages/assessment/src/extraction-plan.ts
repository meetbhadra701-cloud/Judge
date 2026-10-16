import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import type { AssessmentStage } from '@judge-copilot/schemas';
import { MAX_CONTRADICTIONS_PER_RUN, MAX_UNKNOWNS_PER_RUN } from './commentary.js';
import { MAX_CLAIMS_PER_RUN, MAX_EVIDENCE_PER_RUN } from './extraction.js';
import type { AssessmentPipelineConfig } from './pipeline-config.js';
import { MAX_RELATIONS_PER_CLAIM, MAX_RELATIONS_PER_RUN } from './relations.js';
import type { WindowingBudgets } from './windowing.js';

/*
 * The extraction PLAN of a run: stage batch sizes, structural caps, the preflight reduction ladder and the identity hash of a source extraction.
 * This was worker code; it lives here, unchanged, because the coverage verifier (P6B-beta3-R2) must derive -- from the run's frozen configuration
 * alone -- which plan (and so which source budget) a persisted extraction was made under. The worker re-exports every name.
 */

/** Bumped when the stage orchestration itself changes in a way that changes what an extraction contains. */
export const EXTRACTION_ORCHESTRATION_VERSION = 'extraction-orchestration/v1' as const;

/** Batch sizes (design §12.3.1). Hard maxima in code; the prompt input schemas enforce their own ceilings as well. */
export const STAGE_BATCH = Object.freeze({
  passagesPerCall: 40,
  fidelityItemsPerCall: 10,
  claimsPerMatchingCall: 20,
  evidenceShownPerCall: 120,
  claimsShownPerCall: 100,
  pairsPerVerificationCall: 8,
});

/** The per-run structural caps (design §12.3.1), before the preflight reduction ladder lowers them. */
export const STRUCTURAL_CAPS = Object.freeze({
  claims: MAX_CLAIMS_PER_RUN,
  evidence: MAX_EVIDENCE_PER_RUN,
  relations: MAX_RELATIONS_PER_RUN,
  relationsPerClaim: MAX_RELATIONS_PER_CLAIM,
  contradictions: MAX_CONTRADICTIONS_PER_RUN,
  unknowns: MAX_UNKNOWNS_PER_RUN,
});

export type ExtractionStage = Extract<
  AssessmentStage,
  | 'claim_extraction'
  | 'evidence_interpretation'
  | 'fidelity_review'
  | 'relation_matching'
  | 'relation_verification'
  | 'contradiction_detection'
  | 'unknown_identification'
>;

export const EXTRACTION_STAGES: readonly ExtractionStage[] = [
  'claim_extraction',
  'evidence_interpretation',
  'fidelity_review',
  'relation_matching',
  'relation_verification',
  'contradiction_detection',
  'unknown_identification',
];

/** What the preflight chose; part of the extraction's identity (a reduced plan is a different extraction). */
export interface EffectivePlan {
  readonly step: number;
  readonly budgets: {
    readonly statement: number;
    readonly source: number;
    readonly metadata: number;
  };
  readonly claimsCap: number;
  readonly evidenceCap: number;
}

/**
 * The SHA-256 of everything that determines what a SOURCE extraction contains (design §4.9): the prompts and schemas of its stages, the
 * provider and models, generation settings, batch sizes, caps, windowing and routing policies, the label policy and the effective
 * preflight plan. Any change is a new extraction; nothing is ever reused across configurations.
 */
export function extractionConfigHash(
  config: AssessmentPipelineConfig,
  plan: EffectivePlan,
): string {
  return sha256Hex(
    canonicalJson({
      id: EXTRACTION_ORCHESTRATION_VERSION,
      provider: config.provider,
      model: config.models.extraction,
      effort: config.generation.effort ?? null,
      maxOutputTokens: config.generation.maxOutputTokens.extraction,
      prompts: config.prompts.filter((prompt) =>
        (EXTRACTION_STAGES as readonly string[]).includes(prompt.stage),
      ),
      policies: config.policies,
      batch: STAGE_BATCH,
      caps: { ...STRUCTURAL_CAPS, claims: plan.claimsCap, evidence: plan.evidenceCap },
      budgets: plan.budgets,
    }),
  );
}

// -- The reduction ladder ------------------------------------------------------------

const SOURCE_FRACTIONS = [1, 0.75, 0.5, 0.25] as const;
const CAP_FACTORS = [0.75, 0.5625, 0.421875, 0.31640625] as const;
const CAP_FLOORS = { claims: 20, evidence: 25 } as const;

/** The ordered plans to try: lower the source budget 100% -> 75% -> 50% -> 25%, then lower the claim/evidence caps by 25% steps to a floor. */
export function ladder(base: WindowingBudgets): EffectivePlan[] {
  const steps: EffectivePlan[] = SOURCE_FRACTIONS.map((fraction, step) => ({
    step,
    budgets: { ...base, source: Math.max(1_000, Math.floor(base.source * fraction)) },
    claimsCap: STRUCTURAL_CAPS.claims,
    evidenceCap: STRUCTURAL_CAPS.evidence,
  }));
  const floorSource = steps[steps.length - 1]?.budgets.source ?? base.source;
  CAP_FACTORS.forEach((factor, index) => {
    steps.push({
      step: SOURCE_FRACTIONS.length + index,
      budgets: { ...base, source: floorSource },
      claimsCap: Math.max(CAP_FLOORS.claims, Math.floor(STRUCTURAL_CAPS.claims * factor)),
      evidenceCap: Math.max(CAP_FLOORS.evidence, Math.floor(STRUCTURAL_CAPS.evidence * factor)),
    });
  });
  return steps;
}
