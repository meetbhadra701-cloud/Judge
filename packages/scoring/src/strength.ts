import type { EvidenceDirectness, EvidenceSpecificity } from '@judge-copilot/schemas';
import { SCORING_PARAMETERS, type EffectiveLevel } from './parameters.js';

/**
 * strength(e) = V(effectiveLevel) × L(directness) × L(specificity), in this multiplication order.
 *
 * Always in (0, 1] for a usable item: the minimum is 0.15 × 0.3 × 0.3 = 0.0135. The strength of
 * evidence of kind `absence`, `unknown` or `contradiction` is 0 and is decided by the caller (such
 * items create uncertainty, never support).
 */
export function evidenceItemStrength(
  level: EffectiveLevel,
  directness: EvidenceDirectness,
  specificity: EvidenceSpecificity,
): number {
  return (
    SCORING_PARAMETERS.levelFactor[level] *
    SCORING_PARAMETERS.directnessFactor[directness] *
    SCORING_PARAMETERS.specificityFactor[specificity]
  );
}
