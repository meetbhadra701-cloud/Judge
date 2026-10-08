import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import { SCORING_PARAMETERS } from './parameters.js';
import { clamp, fromNumber, ONE, roundHalfUp, ZERO, type Rational } from './rational.js';

/*
 * Canonical serialization, hashing and the one rounding rule.
 *
 * Reports are hashed as canonical JSON (recursively sorted keys). Hashes cover exactly what is
 * needed to reproduce a report: parameters, rubric, options, judgments, track context and the graph
 * facts that can influence the output. They never include a clock, a random value or a generated ID.
 */

export { canonicalJson, sha256Hex };

export function hashOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Rounds a value ONCE, half-up, to the engine's reported precision, EXACTLY (see rational.ts): a
 * rational is rounded as the exact fraction it is; a number is rounded as the decimal it prints as.
 * Rounded values are for the report only and are NEVER an input to another computation, so rounding
 * cannot compound into drift. Negative zero is normalized to zero.
 */
export function roundReported(value: number | Rational): number {
  const exact = typeof value === 'number' ? fromNumber(value) : value;
  return roundHalfUp(exact, SCORING_PARAMETERS.roundingDecimals);
}

/** Clamps into [0, 1] (exact arithmetic cannot overshoot; this is a guard, not a repair). */
export function clampRatio(value: Rational): Rational {
  return clamp(value, ZERO, ONE);
}

/** Locale-independent string comparison (UTF-16 code unit order). */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
