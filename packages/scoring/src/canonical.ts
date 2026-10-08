import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import { SCORING_PARAMETERS } from './parameters.js';

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

/** 10^decimals by exact repeated multiplication (no exponentiation function or operator). */
const ROUNDING_SCALE = (() => {
  let scale = 1;
  for (let i = 0; i < SCORING_PARAMETERS.roundingDecimals; i += 1) scale *= 10;
  return scale;
})();

/**
 * Rounds a non-negative finite number once, half-up, to the engine's reported precision. Rounded
 * values are for the report only and are NEVER an input to another computation, so rounding cannot
 * compound into drift. Negative zero is normalized to zero.
 */
export function roundReported(value: number): number {
  const rounded = Math.round(value * ROUNDING_SCALE) / ROUNDING_SCALE;
  return rounded === 0 ? 0 : rounded;
}

/** Clamps representation noise (for example 1.0000000000000002) into [0, 1] before rounding. */
export function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Locale-independent string comparison (UTF-16 code unit order). */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
