import { hashOf } from './canonical.js';
import { SCORING_PARAMETERS } from './parameters.js';
import { FALLBACK_RUBRIC_DEFINITION } from './rubric/fallback.js';

/**
 * Hash of every constant and of the fallback rubric definition (weights AND evidence-need groups):
 * everything that, besides the inputs, determines a report. Embedded in every report.
 */
export const parametersHash: string = hashOf({
  parameters: SCORING_PARAMETERS,
  fallbackRubric: FALLBACK_RUBRIC_DEFINITION,
});
