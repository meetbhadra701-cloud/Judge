import { canonicalJson } from '@judge-copilot/context';
import {
  ASSESSMENT_CALL_TIMEOUT_MS,
  ASSESSMENT_STAGE_VALUES,
  ProviderMode,
} from '@judge-copilot/schemas';
import { z } from 'zod';
import { CANDIDATE_POLICY } from './candidates.js';
import { EVENT_REFERENCE_BUILDER } from './event-evidence.js';
import { LABEL_POLICY_ID } from './label-policy.js';
import { DEFAULT_BUDGETS, SELECTION_POLICY, WINDOWING_POLICY } from './windowing.js';
import { SOURCE_ROUTING_POLICY } from './routing.js';

/*
 * The pipeline configuration of a run (design §8.6, §12), SHARED by the API (which freezes it into the run request, where it is hashed into
 * every identity) and the worker (which re-validates it when it claims the run). It is the deterministic, provider-independent part of the
 * configuration: schema, defaults, policy identifiers, canonical form. It contains no secret, no URL and no prompt text: ids, versions,
 * hashes, model names and numbers only. The prompt identities are an INPUT (this layer-2 package never imports `prompts`); the single
 * composition with the current prompts lives in the prompts package, which both apps call, so one logical request has one identity.
 */

export const PIPELINE_ID = 'assessment-pipeline/v1' as const;
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
  /** The prompt identities in stage order (the prompts package supplies the current ones; this package never imports it). */
  readonly prompts: AssessmentPipelineConfig['prompts'];
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
    prompts: options.prompts,
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
  runtime: {
    readonly providerId: string;
    readonly providerMode: string;
    /** The prompt identities of the code that is about to run. */
    readonly prompts: AssessmentPipelineConfig['prompts'];
  },
): ConfigCheck {
  const parsed = AssessmentPipelineConfig.safeParse(stored);
  if (!parsed.success) return { ok: false, code: 'pipeline_config_invalid' };
  const config = parsed.data;
  if (canonicalJson(config.prompts) !== canonicalJson(runtime.prompts)) {
    return { ok: false, code: 'pipeline_config_stale' };
  }
  if (config.provider.mode !== runtime.providerMode)
    return { ok: false, code: 'provider_mode_mismatch' };
  if (config.provider.id !== runtime.providerId) return { ok: false, code: 'provider_id_mismatch' };
  return { ok: true, config };
}
