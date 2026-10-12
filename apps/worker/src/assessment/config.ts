import {
  MAX_CLAIMS_PER_RUN,
  MAX_CONTRADICTIONS_PER_RUN,
  MAX_EVIDENCE_PER_RUN,
  MAX_RELATIONS_PER_CLAIM,
  MAX_RELATIONS_PER_RUN,
  MAX_UNKNOWNS_PER_RUN,
  type AssessmentPipelineConfig,
} from '@judge-copilot/assessment';
import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import { PRICES_V1 } from '@judge-copilot/llm';
import type { AssessmentStage, PriceTable } from '@judge-copilot/schemas';

/*
 * The pipeline configuration of a run (design §8.6, §12). It is chosen when the run is REQUESTED (P6's API will build it with
 * `buildPipelineConfig`), frozen into `assessment_run_inputs.pipeline_config`, and hashed into every identity by the run store. The worker
 * re-validates it when it claims the run and REFUSES to run when it does not describe the code that is about to execute (a stale prompt
 * version, a different provider mode): an identity that no longer describes the computation would silently break reuse and audit.
 *
 * It contains no secret, no URL and no prompt text: ids, versions, hashes, model names and numbers only.
 */

/** Bumped when the stage orchestration itself changes in a way that changes what an extraction contains. */
export const EXTRACTION_ORCHESTRATION_VERSION = 'extraction-orchestration/v1' as const;

// The schema, defaults and checks are SHARED with the API (`@judge-copilot/assessment`), and the composition with the current prompts
// is the one in `@judge-copilot/prompts`: the worker and the API derive the same canonical configuration.
export {
  AssessmentPipelineConfig,
  PIPELINE_ID,
  type ConfigCheck,
  type ConfigRejection,
  type PipelineConfigOptions,
} from '@judge-copilot/assessment';
export {
  buildPipelineConfig,
  checkPipelineConfig,
  currentPromptIdentities,
} from '@judge-copilot/prompts';

/** The dated price tables the guard may use. A run names its table; an unknown name fails the run before any call. */
export const PRICE_TABLES: Readonly<Record<string, PriceTable>> = Object.freeze({
  [PRICES_V1.id]: PRICES_V1,
});

// -- Stage parameters ------------------------------------------------------------------------------------------------------

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

/** The configuration hash of a CONTEXT-evidence extraction: model-free, so only the builder and label policy define it. */
export function contextConfigHash(config: AssessmentPipelineConfig): string {
  return sha256Hex(
    canonicalJson({
      id: 'context-extraction/v1',
      referenceBuilder: config.policies.referenceBuilder,
      label: config.policies.label,
    }),
  );
}
