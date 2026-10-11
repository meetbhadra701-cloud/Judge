import {
  CANDIDATE_POLICY,
  DEFAULT_BUDGETS,
  EVENT_REFERENCE_BUILDER,
  LABEL_POLICY_ID,
  MAX_CLAIMS_PER_RUN,
  MAX_CONTRADICTIONS_PER_RUN,
  MAX_EVIDENCE_PER_RUN,
  MAX_RELATIONS_PER_CLAIM,
  MAX_RELATIONS_PER_RUN,
  MAX_UNKNOWNS_PER_RUN,
  SELECTION_POLICY,
  SOURCE_ROUTING_POLICY,
  WINDOWING_POLICY,
} from '@judge-copilot/assessment';
import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import { PRICES_V1 } from '@judge-copilot/llm';
import { PROMPT_REGISTRY } from '@judge-copilot/prompts';
import {
  ASSESSMENT_CALL_TIMEOUT_MS,
  ASSESSMENT_STAGE_VALUES,
  ProviderMode,
  type AssessmentStage,
  type PriceTable,
} from '@judge-copilot/schemas';
import { z } from 'zod';

/*
 * The pipeline configuration of a run (design §8.6, §12). It is chosen when the run is REQUESTED (P6's API will build it with
 * `buildPipelineConfig`), frozen into `assessment_run_inputs.pipeline_config`, and hashed into every identity by the run store. The worker
 * re-validates it when it claims the run and REFUSES to run when it does not describe the code that is about to execute (a stale prompt
 * version, a different provider mode): an identity that no longer describes the computation would silently break reuse and audit.
 *
 * It contains no secret, no URL and no prompt text: ids, versions, hashes, model names and numbers only.
 */

export const PIPELINE_ID = 'assessment-pipeline/v1' as const;
/** Bumped when the stage orchestration itself changes in a way that changes what an extraction contains. */
export const EXTRACTION_ORCHESTRATION_VERSION = 'extraction-orchestration/v1' as const;

const ModelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/);
const Tokens = z.number().int().min(256).max(64_000);

export const AssessmentPipelineConfig = z.strictObject({
  pipeline: z.literal(PIPELINE_ID),
  provider: z.strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    mode: ProviderMode,
  }),
  /** Extraction-tier stages (S2-S6, S3b, S4b), the dimension assessor (S10) and the critic (S11). */
  models: z.strictObject({ extraction: ModelId, assessment: ModelId, critic: ModelId }),
  generation: z.strictObject({
    effort: z.enum(['low', 'medium', 'high']).optional(),
    maxOutputTokens: z.strictObject({ extraction: Tokens, assessment: Tokens, critic: Tokens }),
    timeoutMs: z.number().int().min(1_000).max(ASSESSMENT_CALL_TIMEOUT_MS.max),
  }),
  windowing: z.strictObject({
    statement: z.number().int().min(1_000).max(DEFAULT_BUDGETS.statement),
    source: z.number().int().min(1_000).max(DEFAULT_BUDGETS.source),
    metadata: z.number().int().min(1_000).max(DEFAULT_BUDGETS.metadata),
  }),
  policies: z.strictObject({
    label: z.literal(LABEL_POLICY_ID),
    windowing: z.literal(WINDOWING_POLICY),
    selection: z.literal(SELECTION_POLICY),
    routing: z.literal(SOURCE_ROUTING_POLICY),
    referenceBuilder: z.literal(EVENT_REFERENCE_BUILDER),
    candidates: z.literal(CANDIDATE_POLICY),
  }),
  prompts: z
    .array(
      z.strictObject({
        stage: z.enum(ASSESSMENT_STAGE_VALUES),
        id: z.string(),
        version: z.string(),
        templateHash: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .length(ASSESSMENT_STAGE_VALUES.length),
  /** Fallback anchors are an unapproved draft: the only accepted value is null (design N12). */
  fallbackAnchorsVersion: z.null(),
});
export type AssessmentPipelineConfig = z.infer<typeof AssessmentPipelineConfig>;

export interface PipelineConfigOptions {
  readonly provider: {
    readonly id: string;
    readonly mode: AssessmentPipelineConfig['provider']['mode'];
  };
  readonly models: AssessmentPipelineConfig['models'];
  readonly effort?: 'low' | 'medium' | 'high';
  readonly maxOutputTokens?: Partial<AssessmentPipelineConfig['generation']['maxOutputTokens']>;
  readonly timeoutMs?: number;
  readonly windowing?: Partial<AssessmentPipelineConfig['windowing']>;
}

/** The current prompt identities, in stage order. */
export function currentPromptIdentities(): AssessmentPipelineConfig['prompts'] {
  return PROMPT_REGISTRY.map(({ stage, id, version, templateHash }) => ({
    stage,
    id,
    version,
    templateHash,
  }));
}

/** Builds a valid configuration for the code that is running now. Throws (Zod) on an invalid combination. */
export function buildPipelineConfig(options: PipelineConfigOptions): AssessmentPipelineConfig {
  return AssessmentPipelineConfig.parse({
    pipeline: PIPELINE_ID,
    provider: options.provider,
    models: options.models,
    generation: {
      ...(options.effort === undefined ? {} : { effort: options.effort }),
      maxOutputTokens: {
        extraction: 8_000,
        assessment: 4_000,
        critic: 2_500,
        ...options.maxOutputTokens,
      },
      timeoutMs: options.timeoutMs ?? ASSESSMENT_CALL_TIMEOUT_MS.default,
    },
    windowing: { ...DEFAULT_BUDGETS, ...options.windowing },
    policies: {
      label: LABEL_POLICY_ID,
      windowing: WINDOWING_POLICY,
      selection: SELECTION_POLICY,
      routing: SOURCE_ROUTING_POLICY,
      referenceBuilder: EVENT_REFERENCE_BUILDER,
      candidates: CANDIDATE_POLICY,
    },
    prompts: currentPromptIdentities(),
    fallbackAnchorsVersion: null,
  });
}

export type ConfigRejection =
  | 'pipeline_config_invalid'
  | 'pipeline_config_stale'
  | 'provider_mode_mismatch'
  | 'provider_id_mismatch';

export type ConfigCheck =
  | { readonly ok: true; readonly config: AssessmentPipelineConfig }
  | { readonly ok: false; readonly code: ConfigRejection };

/**
 * Is the stored configuration valid, current, and for the provider that is actually configured here? A run requested for a replay
 * demonstration must never be executed by a live provider (and the reverse): its identity, its extractions and its stored
 * `provider_mode` all say which it is.
 */
export function checkPipelineConfig(
  stored: Readonly<Record<string, unknown>>,
  runtime: { readonly providerId: string; readonly providerMode: string },
): ConfigCheck {
  const parsed = AssessmentPipelineConfig.safeParse(stored);
  if (!parsed.success) return { ok: false, code: 'pipeline_config_invalid' };
  const config = parsed.data;
  if (canonicalJson(config.prompts) !== canonicalJson(currentPromptIdentities())) {
    return { ok: false, code: 'pipeline_config_stale' };
  }
  if (config.provider.mode !== runtime.providerMode)
    return { ok: false, code: 'provider_mode_mismatch' };
  if (config.provider.id !== runtime.providerId) return { ok: false, code: 'provider_id_mismatch' };
  return { ok: true, config };
}

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
