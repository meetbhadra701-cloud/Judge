import {
  buildPipelineConfig as buildSharedPipelineConfig,
  checkPipelineConfig as checkSharedPipelineConfig,
  type AssessmentPipelineConfig,
  type ConfigCheck,
  type PipelineConfigOptions,
} from '@judge-copilot/assessment';
import { PROMPT_REGISTRY } from './templates.js';

/*
 * The ONE composition of the shared pipeline configuration with the CURRENT prompt identities. The API calls `buildPipelineConfig` when it
 * freezes a run request; the worker calls `checkPipelineConfig` when it claims the run; both therefore describe the same code, and one
 * logical request has exactly one canonical configuration and one hash. The pure schema, defaults and checks live in
 * `@judge-copilot/assessment` (layer 2, which never imports this package).
 */

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
export function buildPipelineConfig(
  options: Omit<PipelineConfigOptions, 'prompts'>,
): AssessmentPipelineConfig {
  return buildSharedPipelineConfig({ ...options, prompts: currentPromptIdentities() });
}

/** Is the stored configuration valid, current, and for the provider that is configured here? */
export function checkPipelineConfig(
  stored: Readonly<Record<string, unknown>>,
  runtime: { readonly providerId: string; readonly providerMode: string },
): ConfigCheck {
  return checkSharedPipelineConfig(stored, { ...runtime, prompts: currentPromptIdentities() });
}
