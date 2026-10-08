import type { CriterionReport, OverallReport, UnofficialPreview } from '@judge-copilot/schemas';
import { UNOFFICIAL_PREVIEW_NOTICE } from '@judge-copilot/schemas';
import { clampRatio, compareText, roundReported } from './canonical.js';
import { denormalizeScore, type DimensionResult } from './dimension.js';
import { SCORING_PARAMETERS } from './parameters.js';
import { add, clamp, div, fromInt, fromNumber, gte, mul, ZERO, type Rational } from './rational.js';
import type { CriterionSpec, RubricSpec } from './rubric/spec.js';

/*
 * Aggregation: dimension -> criterion -> overall (docs/milestones/M4-design.md §4.6 and §5.4).
 *
 *  - Insufficient evidence is a STATE. An insufficient dimension or criterion is excluded from the
 *    weighted mean (never filled with 0, never a deduction). Excluding a unit can move an
 *    aggregate in either direction.
 *  - Scores use the PUBLISHED weights as they are when every child is assessed (no division, so an
 *    official weight set that sums to 1 within 1e-6 is never renormalized). Only when children are
 *    missing is the mean taken over the assessed weight, explicitly, and reported as partial.
 *  - A number is reported only if enough weight is assessed: criterion >= 0.5, overall >= 0.6.
 *    The comparison is EXACT (rational arithmetic on the decimal values): there is no tolerance, so
 *    a share just below a threshold is below it, and exactly 0.60 meets 0.6.
 *  - Coverage, citation presence and confidence are weighted means over ALL applicable children
 *    (insufficient children contribute their own, possibly zero, values), so gaps lower confidence
 *    while leaving the score untouched.
 *  - Everything is an exact rational until the report is built; rounding happens once, there, and a
 *    rounded value is never an input to another step.
 */

interface CriterionResult {
  readonly spec: CriterionSpec;
  readonly state: CriterionReport['state'];
  readonly score10: Rational | null;
  readonly coverage: Rational | null;
  readonly presence: Rational | null;
  readonly confidence: Rational;
  readonly assessedShare: Rational;
  readonly dimensionIds: readonly string[];
  readonly missingDimensionIds: readonly string[];
}

export interface AggregateOutput {
  readonly criteria: CriterionReport[];
  readonly overall: OverallReport;
  readonly unofficialPreview: UnofficialPreview | null;
}

const CRITERION_THRESHOLD = fromNumber(SCORING_PARAMETERS.minAssessedShare.criterion);
const OVERALL_THRESHOLD = fromNumber(SCORING_PARAMETERS.minAssessedShare.overall);
const TEN = fromInt(10);

const ratio = (value: Rational) => roundReported(clampRatio(value));
const score = (value: Rational) => roundReported(clamp(value, ZERO, TEN));

export function aggregate(
  rubric: RubricSpec,
  results: ReadonlyMap<string, DimensionResult>,
  wantPreview: boolean,
): AggregateOutput {
  const computed = new Map<string, CriterionResult>();
  for (const spec of [...rubric.criteria].sort((a, b) => compareText(a.key, b.key))) {
    computed.set(spec.key, criterionResult(spec, results));
  }

  const criteria = rubric.criteria.map((spec) =>
    criterionReport(rubric, spec, computed.get(spec.key)),
  );
  const applicable = [...computed.values()].filter((entry) => entry.spec.applicable);

  if (rubric.weightBasis === 'unweighted_official') {
    return {
      criteria,
      overall: {
        state: 'not_computed',
        weightBasis: 'unweighted_official',
        reason: 'unweighted_official_rubric',
      },
      unofficialPreview: wantPreview ? preview(rubric, applicable) : null,
    };
  }

  return {
    criteria,
    overall: weightedOverall(rubric, applicable),
    unofficialPreview: null,
  };
}

// -- Criterion ---------------------------------------------------------------------------------

function criterionResult(
  spec: CriterionSpec,
  results: ReadonlyMap<string, DimensionResult>,
): CriterionResult {
  if (!spec.applicable) {
    return {
      spec,
      state: 'not_applicable',
      score10: null,
      coverage: null,
      presence: null,
      confidence: ZERO,
      assessedShare: ZERO,
      dimensionIds: [],
      missingDimensionIds: [],
    };
  }
  const dims = [...spec.dimensions]
    .sort((a, b) => compareText(a.id, b.id))
    .map((dimension) => {
      const result = results.get(dimension.id);
      if (!result) throw new Error('internal: missing dimension result');
      return { weight: fromNumber(dimension.weight), result };
    });

  let totalWeight = ZERO;
  let assessedWeight = ZERO;
  let weightedScore = ZERO;
  let coverage = ZERO;
  let presence = ZERO;
  let confidence = ZERO;
  for (const { weight, result } of dims) {
    totalWeight = add(totalWeight, weight);
    coverage = add(coverage, mul(weight, result.coverage ?? ZERO));
    presence = add(presence, mul(weight, fromInt(result.citationPresence ?? 0)));
    confidence = add(confidence, mul(weight, result.confidence));
    if (result.state === 'assessed' && result.score10 !== null) {
      assessedWeight = add(assessedWeight, weight);
      weightedScore = add(weightedScore, mul(weight, result.score10));
    }
  }
  const assessedCount = dims.filter(({ result }) => result.state === 'assessed').length;
  const allAssessed = assessedCount === dims.length;
  const share = div(assessedWeight, totalWeight);
  const declared = spec.dimensions.every((dimension) => dimension.needGroups !== null);

  let state: CriterionReport['state'];
  if (allAssessed) state = 'assessed';
  else if (assessedCount > 0 && gte(share, CRITERION_THRESHOLD)) state = 'partial';
  else state = 'insufficient_evidence';

  return {
    spec,
    state,
    score10:
      state === 'insufficient_evidence'
        ? null
        : allAssessed
          ? weightedScore
          : div(weightedScore, assessedWeight),
    coverage: declared ? div(coverage, totalWeight) : null,
    presence: declared ? null : div(presence, totalWeight),
    confidence: div(confidence, totalWeight),
    assessedShare: share,
    dimensionIds: dims.map(({ result }) => result.spec.id),
    missingDimensionIds: dims
      .filter(({ result }) => result.state !== 'assessed')
      .map(({ result }) => result.spec.id),
  };
}

function criterionReport(
  rubric: RubricSpec,
  spec: CriterionSpec,
  result: CriterionResult | undefined,
): CriterionReport {
  if (!result) throw new Error('internal: missing criterion result');
  if (result.state === 'not_applicable') {
    return {
      key: spec.key,
      name: spec.name,
      weight: spec.weight,
      state: 'not_applicable',
      reason: 'no_declared_tracks',
    };
  }
  const common = {
    key: spec.key,
    name: spec.name,
    weight: spec.weight,
    assessedWeightShare: ratio(result.assessedShare),
    coverage: result.coverage === null ? null : ratio(result.coverage),
    citationPresenceShare: result.presence === null ? null : ratio(result.presence),
    confidence: ratio(result.confidence),
    dimensionIds: [...result.dimensionIds],
    missingDimensionIds: [...result.missingDimensionIds],
  };
  if (result.state === 'insufficient_evidence' || result.score10 === null) {
    return { ...common, state: 'insufficient_evidence' };
  }
  return {
    ...common,
    state: result.state,
    score10: score(result.score10),
    scoreOnScale: onScale(rubric, result.score10),
  };
}

/** The value on the rubric's own scale, exact, clamped into the scale, rounded once. */
function onScale(rubric: RubricSpec, score10: Rational): number {
  const value = denormalizeScore(clamp(score10, ZERO, TEN), rubric.scale);
  return roundReported(clamp(value, fromNumber(rubric.scale.min), fromNumber(rubric.scale.max)));
}

// -- Overall -----------------------------------------------------------------------------------

function weightedOverall(
  rubric: RubricSpec,
  applicable: readonly CriterionResult[],
): OverallReport {
  const weightBasis = rubric.weightBasis === 'official' ? 'official' : 'fallback';
  let total = ZERO;
  let scoredWeight = ZERO;
  let weightedScore = ZERO;
  let coverage = ZERO;
  let presence = ZERO;
  let confidence = ZERO;
  for (const entry of applicable) {
    const weight = fromNumber(entry.spec.weight ?? 0);
    total = add(total, weight);
    coverage = add(coverage, mul(weight, entry.coverage ?? ZERO));
    presence = add(presence, mul(weight, entry.presence ?? ZERO));
    confidence = add(confidence, mul(weight, entry.confidence));
    if (entry.score10 !== null) {
      scoredWeight = add(scoredWeight, weight);
      weightedScore = add(weightedScore, mul(weight, entry.score10));
    }
  }
  const scored = applicable.filter((entry) => entry.score10 !== null);
  const allScored = scored.length === applicable.length;
  const everyAssessed = applicable.every((entry) => entry.state === 'assessed');
  const share = div(scoredWeight, total);
  const declared = rubric.needsBasis === 'declared';
  const missingCriterionKeys = applicable
    .filter((entry) => entry.score10 === null)
    .map((entry) => entry.spec.key);
  const common = {
    assessedWeightShare: ratio(share),
    coverage: declared ? ratio(div(coverage, total)) : null,
    citationPresenceShare: declared ? null : ratio(div(presence, total)),
    confidence: ratio(div(confidence, total)),
    missingCriterionKeys,
  };

  if (scored.length === 0 || !gte(share, OVERALL_THRESHOLD)) {
    return {
      state: 'insufficient_evidence',
      weightBasis,
      reason: 'assessed_weight_below_threshold',
      ...common,
    };
  }
  // Published weights are used as they are only when EVERY criterion of the rubric is scored; a
  // not_applicable or unscored criterion means the mean is taken over the scored weight, explicitly.
  const asPublished = allScored && applicable.length === rubric.criteria.length;
  const value = asPublished ? weightedScore : div(weightedScore, scoredWeight);
  return {
    state: everyAssessed ? 'scored' : 'scored_partial',
    weightBasis,
    score10: score(value),
    scoreOnScale: onScale(rubric, value),
    ...common,
  };
}

// -- Explicit, unofficial equal-weight preview -------------------------------------------------

function preview(rubric: RubricSpec, applicable: readonly CriterionResult[]): UnofficialPreview {
  const count = fromInt(applicable.length);
  const scored = applicable.filter((entry) => entry.score10 !== null);
  const share = div(fromInt(scored.length), count);
  let scoreSum = ZERO;
  let presence = ZERO;
  let confidence = ZERO;
  for (const entry of applicable) {
    presence = add(presence, entry.presence ?? ZERO);
    confidence = add(confidence, entry.confidence);
    scoreSum = add(scoreSum, entry.score10 ?? ZERO);
  }
  const missingCriterionKeys = applicable
    .filter((entry) => entry.score10 === null)
    .map((entry) => entry.spec.key);
  const head = {
    kind: 'unofficial_equal_weight_preview',
    official: false,
    weightBasis: 'equal_assumed',
    notice: UNOFFICIAL_PREVIEW_NOTICE,
    assessedWeightShare: ratio(share),
    coverage: null,
    citationPresenceShare: ratio(div(presence, count)),
    confidence: ratio(div(confidence, count)),
    missingCriterionKeys,
  } as const;

  if (scored.length === 0 || !gte(share, OVERALL_THRESHOLD)) {
    return { ...head, state: 'insufficient_evidence' };
  }
  const mean = div(scoreSum, fromInt(scored.length));
  return {
    ...head,
    state:
      scored.length === applicable.length && applicable.every((entry) => entry.state === 'assessed')
        ? 'scored'
        : 'scored_partial',
    score10: score(mean),
    scoreOnScale: onScale(rubric, mean),
  };
}
