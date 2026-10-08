import { RUBRIC_WEIGHT_SUM_TOLERANCE } from '@judge-copilot/context';

/*
 * Validation of PUBLISHED criterion weights. They are validated, never repaired, renormalized or
 * replaced. The invariant (docs/SCORING.md §2.5) is:
 *
 *   - every weight is finite and in (0, 1];
 *   - all-or-none: either every criterion has a weight or none does;
 *   - the TOTAL differs from 1 by at most RUBRIC_WEIGHT_SUM_TOLERANCE (absolute).
 *
 * It is a property of the total, not of each weight: compensating changes that keep the total at 1
 * are valid. The sum is taken in published order, exactly as Event Context locking does, so a rubric
 * that locked is never rejected here for floating-point reasons.
 */

export type WeightValidation =
  | { readonly ok: true; readonly weighted: boolean }
  | { readonly ok: false; readonly messages: readonly string[] };

export function validatePublishedWeights(weights: readonly (number | null)[]): WeightValidation {
  const messages: string[] = [];
  const present = weights.filter((weight): weight is number => weight !== null);
  if (present.length === 0) return { ok: true, weighted: false };
  if (present.length !== weights.length) {
    return { ok: false, messages: ['Either every criterion has a weight or none does'] };
  }
  present.forEach((weight, index) => {
    if (!Number.isFinite(weight) || weight <= 0 || weight > 1) {
      messages.push(
        `Criterion ${String(index + 1)} weight must be finite, greater than 0 and at most 1`,
      );
    }
  });
  if (messages.length > 0) return { ok: false, messages };
  const total = present.reduce((sum, weight) => sum + weight, 0);
  if (Math.abs(total - 1) > RUBRIC_WEIGHT_SUM_TOLERANCE) {
    return {
      ok: false,
      messages: [
        `Criterion weights sum to ${String(Number(total.toFixed(9)))}, not 1 (tolerance ${String(RUBRIC_WEIGHT_SUM_TOLERANCE)})`,
      ],
    };
  }
  return { ok: true, weighted: true };
}
