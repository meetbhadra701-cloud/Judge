import { SCORING_PARAMETERS } from '../parameters.js';
import { fromNumber, gte, sub } from '../rational.js';

/*
 * The official-scale policy. An official rubric publishes its own scale [scaleMin, scaleMax]; the
 * engine normalizes judged values to 0-10 (`10·(x − min)/(max − min)`, ASSUMING the scale is linear),
 * aggregates, and maps back for reporting. That path is only meaningful when:
 *
 *   1. both endpoints are finite numbers;
 *   2. neither exceeds ±maxMagnitude (1,000,000), so the normalized, denormalized and four-decimal
 *      rounded values are all exactly representable doubles (1e6 at four decimals is 1e10, far below
 *      2^53) and nothing can overflow or underflow;
 *   3. the range max − min is at least minRange (0.01), so the reporting precision (four decimals)
 *      distinguishes at least 100 steps of the scale and the division by the range is well
 *      conditioned; a subnormal or vanishing range is refused rather than silently collapsing every
 *      judged value onto one reported number.
 *
 * Ordinary scales (0-10, 1-5, 0-100, -5 to 5, 0-1) are all accepted and unchanged. A rejected scale is
 * a typed RUBRIC_INVALID raised before any normalization or scoring, never an internal exception.
 */

export function validateOfficialScale(min: unknown, max: unknown): string | null {
  if (typeof min !== 'number' || typeof max !== 'number') {
    return 'The official rubric scale must be numbers';
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return 'The official rubric scale must be finite';
  }
  const { maxMagnitude, minRange } = SCORING_PARAMETERS.officialScale;
  if (Math.abs(min) > maxMagnitude || Math.abs(max) > maxMagnitude) {
    return `The official rubric scale must lie within ±${String(maxMagnitude)}`;
  }
  if (!(min < max)) {
    return 'The official rubric scale must have a minimum below its maximum';
  }
  // Exact: no floating-point subtraction can hide an unusably small range.
  if (!gte(sub(fromNumber(max), fromNumber(min)), fromNumber(minRange))) {
    return `The official rubric scale must span at least ${String(minRange)}`;
  }
  return null;
}
