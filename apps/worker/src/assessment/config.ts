import { type AssessmentPipelineConfig } from '@judge-copilot/assessment';
import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import { PRICES_V1 } from '@judge-copilot/llm';
import type { PriceTable } from '@judge-copilot/schemas';

/*
 * The pipeline configuration of a run (design §8.6, §12). It is chosen when the run is REQUESTED (P6's API will build it with
 * `buildPipelineConfig`), frozen into `assessment_run_inputs.pipeline_config`, and hashed into every identity by the run store. The worker
 * re-validates it when it claims the run and REFUSES to run when it does not describe the code that is about to execute (a stale prompt
 * version, a different provider mode): an identity that no longer describes the computation would silently break reuse and audit.
 *
 * It contains no secret, no URL and no prompt text: ids, versions, hashes, model names and numbers only.
 */

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
  EXTRACTION_ORCHESTRATION_VERSION,
  EXTRACTION_STAGES,
  extractionConfigHash,
  ladder,
  STAGE_BATCH,
  STRUCTURAL_CAPS,
  type EffectivePlan,
  type ExtractionStage,
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
