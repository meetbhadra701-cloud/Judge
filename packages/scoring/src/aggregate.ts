import type { CriterionReport, OverallReport, UnofficialPreview } from '@judge-copilot/schemas';
import { UNOFFICIAL_PREVIEW_NOTICE } from '@judge-copilot/schemas';
import { clampRatio, compareText, roundReported } from './canonical.js';
import { denormalizeScore, type DimensionResult } from './dimension.js';
import { SCORING_PARAMETERS } from './parameters.js';
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
 *  - Coverage, citation presence and confidence are weighted means over ALL applicable children
 *    (insufficient children contribute their own, possibly zero, value), so gaps lower confidence
 *    while leaving the score untouched.
 *  - Folds run in ascending ID/key order so floating-point sums do not depend on any input order.
 *  - Everything is unrounded here; rounding happens once, when the report is built.
 */

interface CriterionResult {
  readonly spec: CriterionSpec;
  readonly state: CriterionReport['state'];
  readonly score10: number | null;
  readonly coverage: number | null;
  readonly presence: number | null;
  readonly confidence: number;
  readonly assessedShare: number;
  readonly dimensionIds: readonly string[];
  readonly missingDimensionIds: readonly string[];
}

export interface AggregateOutput {
  readonly criteria: CriterionReport[];
  readonly overall: OverallReport;
  readonly unofficialPreview: UnofficialPreview | null;
}

const { minAssessedShare, shareEpsilon } = SCORING_PARAMETERS;
const meets = (share: number, threshold: number) => share + shareEpsilon >= threshold;

const ratio = (value: number) => roundReported(clampRatio(value));
const score = (value: number) => roundReported(Math.min(10, Math.max(0, value)));

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
      confidence: 0,
      assessedShare: 0,
      dimensionIds: [],
      missingDimensionIds: [],
    };
  }
  const dims = [...spec.dimensions]
    .sort((a, b) => compareText(a.id, b.id))
    .map((dimension) => {
      const result = results.get(dimension.id);
      if (!result) throw new Error('internal: missing dimension result');
      return { weight: dimension.weight, result };
    });

  let totalWeight = 0;
  let assessedWeight = 0;
  let weightedScore = 0;
  let coverage = 0;
  let presence = 0;
  let confidence = 0;
  for (const { weight, result } of dims) {
    totalWeight += weight;
    coverage += weight * (result.coverage ?? 0);
    presence += weight * (result.citationPresence ?? 0);
    confidence += weight * result.confidence;
    if (result.state === 'assessed' && result.score10 !== null) {
      assessedWeight += weight;
      weightedScore += weight * result.score10;
    }
  }
  const assessedCount = dims.filter(({ result }) => result.state === 'assessed').length;
  const allAssessed = assessedCount === dims.length;
  const share = assessedWeight / totalWeight;
  const declared = spec.dimensions.every((dimension) => dimension.needGroups !== null);

  let state: CriterionReport['state'];
  if (allAssessed) state = 'assessed';
  else if (assessedCount > 0 && meets(share, minAssessedShare.criterion)) state = 'partial';
  else state = 'insufficient_evidence';

  return {
    spec,
    state,
    score10:
      state === 'insufficient_evidence'
        ? null
        : allAssessed
          ? weightedScore
          : weightedScore / assessedWeight,
    coverage: declared ? coverage / totalWeight : null,
    presence: declared ? null : presence / totalWeight,
    confidence: confidence / totalWeight,
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

function onScale(rubric: RubricSpec, score10: number): number {
  const value = denormalizeScore(Math.min(10, Math.max(0, score10)), rubric.scale);
  return roundReported(Math.min(rubric.scale.max, Math.max(rubric.scale.min, value)));
}

// -- Overall -----------------------------------------------------------------------------------

function weightedOverall(
  rubric: RubricSpec,
  applicable: readonly CriterionResult[],
): OverallReport {
  const weightBasis = rubric.weightBasis === 'official' ? 'official' : 'fallback';
  let total = 0;
  let scoredWeight = 0;
  let weightedScore = 0;
  let coverage = 0;
  let presence = 0;
  let confidence = 0;
  for (const entry of applicable) {
    const weight = entry.spec.weight ?? 0;
    total += weight;
    coverage += weight * (entry.coverage ?? 0);
    presence += weight * (entry.presence ?? 0);
    confidence += weight * entry.confidence;
    if (entry.score10 !== null) {
      scoredWeight += weight;
      weightedScore += weight * entry.score10;
    }
  }
  const scored = applicable.filter((entry) => entry.score10 !== null);
  const allScored = scored.length === applicable.length;
  const everyAssessed = applicable.every((entry) => entry.state === 'assessed');
  const share = scoredWeight / total;
  const declared = rubric.needsBasis === 'declared';
  const missingCriterionKeys = applicable
    .filter((entry) => entry.score10 === null)
    .map((entry) => entry.spec.key);
  const common = {
    assessedWeightShare: ratio(share),
    coverage: declared ? ratio(coverage / total) : null,
    citationPresenceShare: declared ? null : ratio(presence / total),
    confidence: ratio(confidence / total),
    missingCriterionKeys,
  };

  if (scored.length === 0 || !meets(share, minAssessedShare.overall)) {
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
  const value = asPublished ? weightedScore : weightedScore / scoredWeight;
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
  const count = applicable.length;
  const scored = applicable.filter((entry) => entry.score10 !== null);
  const share = scored.length / count;
  let scoreSum = 0;
  let presence = 0;
  let confidence = 0;
  for (const entry of applicable) {
    presence += entry.presence ?? 0;
    confidence += entry.confidence;
    scoreSum += entry.score10 ?? 0;
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
    citationPresenceShare: ratio(presence / count),
    confidence: ratio(confidence / count),
    missingCriterionKeys,
  } as const;

  if (scored.length === 0 || !meets(share, minAssessedShare.overall)) {
    return { ...head, state: 'insufficient_evidence' };
  }
  const mean = scoreSum / scored.length;
  return {
    ...head,
    state:
      scored.length === count && applicable.every((entry) => entry.state === 'assessed')
        ? 'scored'
        : 'scored_partial',
    score10: score(mean),
    scoreOnScale: onScale(rubric, mean),
  };
}
