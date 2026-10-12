import { buildPipelineConfig } from '@judge-copilot/prompts';
import { ASSESSMENT_PRICE_TABLE_ID, AssessmentRunLimits } from '@judge-copilot/schemas';
import type { OfflineAssessmentRuntime } from './runtime-gate.js';

/*
 * What the API freezes into a run request: the SHARED pipeline configuration (the same function the worker validates against), the
 * default local spending limits and the price table. Nothing here is chosen by the client; the request body carries only the mode.
 */

export interface FrozenRequestParts {
  readonly pipelineConfig: ReturnType<typeof buildPipelineConfig>;
  readonly limits: AssessmentRunLimits;
  readonly priceTableId: string;
}

export function frozenRequestParts(runtime: OfflineAssessmentRuntime): FrozenRequestParts {
  return {
    pipelineConfig: buildPipelineConfig({ provider: runtime.provider, models: runtime.models }),
    limits: AssessmentRunLimits.parse({}),
    priceTableId: ASSESSMENT_PRICE_TABLE_ID,
  };
}
