import type { EvidenceDirectness, EvidenceSpecificity } from '@judge-copilot/schemas';
import { SCORING_PARAMETERS, type EffectiveLevel } from './parameters.js';
import { fromNumber, mul, type Rational } from './rational.js';

const entries = <K extends string>(table: Record<K, number>) =>
  Object.fromEntries(
    (Object.keys(table) as K[]).map((key) => [key, fromNumber(table[key])] as const),
  ) as Record<K, Rational>;

const LEVEL = entries(SCORING_PARAMETERS.levelFactor);
const DIRECTNESS = entries(SCORING_PARAMETERS.directnessFactor);
const SPECIFICITY = entries(SCORING_PARAMETERS.specificityFactor);

/**
 * strength(e) = V(effectiveLevel) × L(directness) × L(specificity), as an EXACT rational (for
 * example 7/20 × 3/5 × 3/5 = 63/500 = 0.126).
 *
 * Always in (0, 1] for a usable item: the minimum is 0.15 × 0.3 × 0.3 = 0.0135. The strength of
 * evidence of kind `absence`, `unknown` or `contradiction` is 0 and is decided by the caller (such
 * items create uncertainty, never support).
 */
export function evidenceItemStrength(
  level: EffectiveLevel,
  directness: EvidenceDirectness,
  specificity: EvidenceSpecificity,
): Rational {
  return mul(mul(LEVEL[level], DIRECTNESS[directness]), SPECIFICITY[specificity]);
}
