import { deepFreeze } from './freeze.js';
import { fromNumber, ZERO, type Rational } from './rational.js';
import {
  FALLBACK_RUBRIC_VERSION,
  SCORING_ENGINE_VERSION,
  type EvidenceDirectness,
  type EvidenceSpecificity,
} from '@judge-copilot/schemas';

/*
 * Every numeric constant of scoring-engine/v1, in one frozen object that is hashed into every
 * report (`parametersHash`).
 *
 * THESE ARE TRANSPARENT V1 HEURISTICS, NOT CALIBRATED STATISTICAL PROBABILITIES. Their ORDER is the
 * claim (a producer-asserted repository corroboration is stronger than a team statement, which is
 * stronger than an unlabeled one; direct beats adjacent beats indirect); their spacing is a judgment
 * call that has not been fitted to judge outcomes. Changing any value is a new engine version.
 *
 * There is deliberately NO entry for `machine_verified`, `judge_verified` or `live_verified`: in M4
 * those labels never raise effective trust (docs/milestones/M4-design.md §2.2). A trusted
 * attestation architecture belongs to the milestone that introduces a trusted producer.
 */

/** The only trust levels M4 can resolve an evidence item to. */
export type EffectiveLevel = 'unverified' | 'team_claim' | 'repo_corroborated';

export const SCORING_PARAMETERS = deepFreeze({
  engineVersion: SCORING_ENGINE_VERSION,
  fallbackRubricVersion: FALLBACK_RUBRIC_VERSION,
  status: 'heuristic_not_calibrated',

  /** V: strength factor of the effective verification level. */
  levelFactor: {
    unverified: 0.15,
    team_claim: 0.35,
    /** Producer-asserted and limited (M3 R1). NOT machine-verified truth. */
    repo_corroborated: 0.6,
  } satisfies Record<EffectiveLevel, number>,

  /** L: the same ladder for the two assessor-classified attributes. */
  directnessFactor: { direct: 1, adjacent: 0.6, indirect: 0.3 } satisfies Record<
    EvidenceDirectness,
    number
  >,
  specificityFactor: { exact: 1, partial: 0.6, generic: 0.3 } satisfies Record<
    EvidenceSpecificity,
    number
  >,

  /**
   * Confidence multiplier by number of distinct recorded contradictions touching a dimension:
   * k = 0, 1, 2, 3 or more. An explicit table (no exponentiation) so every value is exact data.
   * An uncertainty marker; it never changes a quality score.
   */
  contradictionFactors: [1, 0.7, 0.49, 0.343],

  /**
   * Minimum share of weight that must be assessed before a number is reported. Compared EXACTLY
   * (rational arithmetic on the decimal values), with no tolerance: a share just below a
   * threshold is below it.
   */
  minAssessedShare: { criterion: 0.5, overall: 0.6 },

  /**
   * Reported numbers are rounded once, half-up, to this many decimals, on the exact value; the
   * rounded number is never fed back into a later step.
   */
  roundingDecimals: 4,

  /**
   * The official scales the engine accepts (see `rubric/scale.ts`): finite endpoints within
   * +/- maxMagnitude and a range of at least minRange. Rationale: every normalized, denormalized
   * and four-decimal-rounded value must be an exactly representable double, and a scale narrower
   * than minRange could not be told apart at the reporting precision.
   */
  officialScale: { maxMagnitude: 1_000_000, minRange: 0.01 },

  /** The fallback rubric's scale. */
  fallbackScale: { min: 0, max: 10 },
});

/** The largest number of contradictions that still lowers confidence. */
export const CONTRADICTION_CAP = SCORING_PARAMETERS.contradictionFactors.length - 1;

const CONTRADICTION_FACTORS: readonly Rational[] =
  SCORING_PARAMETERS.contradictionFactors.map(fromNumber);

/** Exact: 1, 7/10, 49/100, 343/1000. */
export function contradictionFactor(distinctContradictions: number): Rational {
  const index = Math.min(distinctContradictions, CONTRADICTION_CAP);
  return CONTRADICTION_FACTORS[index] ?? ZERO;
}
