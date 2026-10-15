import type {
  AssessmentDetail,
  AssessmentJudgmentView,
  AssessmentListResponse,
  AssessmentRunView,
  ScoreReport,
} from '@judge-copilot/schemas';

/**
 * The single place that decides which of the assessment page's states applies. It is pure and
 * only ever CLASSIFIES what the API returned: it never computes, defaults or fills in a number.
 * A dimension or overall without a score stays without one; a failed or cancelled run is never
 * shown as a success.
 */
export type AssessmentPageState =
  /** No assessment and no run has ever been requested. */
  | 'none'
  /** A run is waiting for, or being executed by, a worker. */
  | 'in_progress'
  /** The latest run failed or was cancelled and there is no newer assessment. */
  | 'run_failed'
  /** An assessment whose stored report could not be re-verified: nothing of it is shown. */
  | 'unverified'
  | 'scored'
  | 'scored_partial'
  /** The overall is insufficient evidence, or no overall number is computed. */
  | 'insufficient_evidence';

export function classifyOverall(
  detail: AssessmentDetail,
): 'scored' | 'scored_partial' | 'insufficient_evidence' | 'unverified' {
  if (!detail.verified || detail.report === null) return 'unverified';
  const state = detail.report.overall.state;
  if (state === 'scored') return 'scored';
  if (state === 'scored_partial') return 'scored_partial';
  // `insufficient_evidence` and `not_computed` both carry no number
  return 'insufficient_evidence';
}

/** The run to explain on the page, if any: an active run, else a failed/cancelled run newer than every assessment. */
export function runToExplain(list: AssessmentListResponse): AssessmentRunView | null {
  if (list.activeRun) return list.activeRun;
  const latest = list.latestRun;
  if (latest === null) return null;
  if (latest.state !== 'failed' && latest.state !== 'cancelled') return null;
  const newest = list.assessments[0];
  // a later success (its assessment's run) supersedes the failure; a failure after it stays visible
  if (newest && newest.runId !== latest.id && newest.createdAt >= latest.createdAt) return null;
  return latest;
}

export function classifyPage(
  list: AssessmentListResponse,
  detail: AssessmentDetail | null,
): AssessmentPageState {
  if (list.activeRun) return 'in_progress';
  if (detail === null) {
    return runToExplain(list) ? 'run_failed' : list.assessments.length > 0 ? 'unverified' : 'none';
  }
  return classifyOverall(detail);
}

/*
 * Number presentation (P6B-α, R6C D12). Two precisions, kept apart:
 *
 *   canonical precision     what the VERIFIED REPORT states: the scoring engine rounded each score ONCE, half-up, to four decimals on the
 *                           decimal the raw number prints as. Reported scores arrive here already rounded, so they are shown AS THEY ARE:
 *                           the decimal text of the number (7.3333 → "7.3333", 7 → "7.0"). Nothing is rounded again, so there is no second,
 *                           binary rounding (`toFixed(1)` turned 7.05 into "7.0" and 8.45 into "8.4").
 *   presentation precision  percentages (confidence index, coverage, shares) are rounded HALF-UP to whole percents for display only,
 *                           by decimal arithmetic on the number's printed digits, never by floating-point multiplication
 *                           (`Math.round(0.285 * 100)` is 28, the decimal half-up value is 29).
 */

const PLAIN_DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/** A finite number as exact decimal parts, or null when its text is not a plain decimal (exponent form). */
function decimalParts(
  value: number,
): { negative: boolean; whole: string; fraction: string } | null {
  if (!Number.isFinite(value)) return null;
  const match = PLAIN_DECIMAL.exec(String(value));
  if (!match) return null;
  return { negative: match[1] === '-', whole: match[2] ?? '0', fraction: match[3] ?? '' };
}

/** A reported score, exactly as the verified report states it, with at least one decimal (7 → "7.0", 7.3333 → "7.3333"). */
export function formatScore10(value: number): string {
  const parts = decimalParts(value);
  if (parts === null) return String(value); // never produced by the engine; shown unrounded rather than rounded wrongly
  const fraction = parts.fraction === '' ? '0' : parts.fraction;
  const sign = parts.negative && /[1-9]/.test(parts.whole + fraction) ? '-' : '';
  return `${sign}${parts.whole}.${fraction}`;
}

/** The rubric's own scale, exactly as the verified report states it. */
export interface RubricScale {
  readonly min: number;
  readonly max: number;
}

/** True for the fallback rubric's 0-10 scale, where the normalized figure IS the native one. */
export function isTenPointScale(scale: RubricScale): boolean {
  return scale.min === 0 && scale.max === 10;
}

/**
 * A reported score in BOTH terms where they differ: the value on the rubric's own scale, then the same value normalized to 0-10 (the
 * form the engine aggregates in). For a 0-10 rubric it is just "7.0 / 10". Both numbers come from the verified report; nothing is
 * computed here, so no presentation choice can change a stored score. A rubric's lowest value is normalized to 0.0, which is a real
 * low score on that rubric, never "no evidence" (a dimension without enough evidence has no number at all).
 */
export function formatScoreOnRubric(
  score10: number,
  scoreOnScale: number,
  scale: RubricScale,
): string {
  if (isTenPointScale(scale)) return `${formatScore10(score10)} / 10`;
  return `${formatScore10(scoreOnScale)} on the rubric’s scale of ${String(scale.min)} to ${String(scale.max)} (${formatScore10(score10)} / 10 normalized)`;
}

/** The explanation that goes with {@link formatScoreOnRubric}; null when the scale is the plain 0-10 one. */
export function scaleExplanation(scale: RubricScale): string | null {
  if (isTenPointScale(scale)) return null;
  return `Scale: this rubric scores from ${String(scale.min)} (lowest) to ${String(scale.max)} (highest). The “/ 10” figures are the same scores normalized to 0–10, where the rubric’s lowest value (${String(scale.min)}) is 0 and its highest (${String(scale.max)}) is 10. A score at the bottom of the scale is a real, low score, not missing evidence: a dimension without enough evidence has no number at all.`;
}

/** A ratio in [0, 1] as a whole percent, rounded half-up on its decimal digits. */
export function formatRatio(value: number): string {
  const parts = decimalParts(value);
  if (parts === null) return `${String(Math.round(value * 100))}%`;
  // value = whole.fraction; percent = value * 100 = (whole + first two fraction digits) . (rest of the digits)
  const padded = `${parts.fraction}00`;
  const percentDigits = BigInt(`${parts.whole}${padded.slice(0, 2)}`);
  const rest = padded.slice(2);
  const roundUp = rest.length > 0 && rest.charCodeAt(0) >= 53; // first dropped digit >= 5 → half-up
  const percent = (parts.negative ? -percentDigits : percentDigits) + (roundUp ? 1n : 0n);
  return `${percent.toString()}%`;
}

/** Cost is shown in USD for readability; it is a local software counter, not a bill. */
export function formatCostNanoUsd(nano: number): string {
  return `$${(nano / 1_000_000_000).toFixed(4)}`;
}

export const FAILURE_EXPLANATIONS: Readonly<Record<string, string>> = {
  provider_error: 'The model provider could not complete a step.',
  schema_validation_failed: 'A model answer did not pass validation, so no score was produced.',
  domain_validation_failed: 'A model answer did not pass validation, so no score was produced.',
  source_unavailable: 'Captured project material needed by the assessment was unavailable.',
  timeout: 'The run exceeded its time limit.',
  budget_exceeded: 'The local spending guard stopped the run.',
  internal_error: 'An internal error stopped the run.',
};

/**
 * Organizer-facing explanations for the specific failure CODES a run can end with, which are more precise than its category (a
 * `provider_error` that is a replay miss is not a provider outage). Codes not listed here fall back to the category explanation.
 */
export const FAILURE_CODE_EXPLANATIONS: Readonly<Record<string, string>> = {
  replay_miss:
    'This offline demonstration has no recorded answer for this material, so it could not continue. Recorded answers exist only for the built-in synthetic demonstration project; no live model is used.',
  fallback_anchors_not_approved:
    'The hackathon’s locked Event Context has no single official overall rubric, and this version does not assess against a fallback rubric.',
  no_context_reference_evidence:
    'The locked Event Context has no rule, requirement or declared track that can be used as reference evidence, and this version cannot assess such a context yet (known limitation).',
  source_coverage_insufficient:
    'The selected evidence showed too little of the repository’s implementation (none of it, or fewer than half of its components) for an assessment to say anything about it. Nothing was spent and nothing was scored. This is a statement about what could be shown, not about the project. Use an assessment with a larger source allowance, or review the repository yourself.',
  no_passages_selected:
    'No captured text could be shown to the assessment, so there is nothing to assess.',
  track_target_not_supported: 'Assessing a single track’s rubric is not supported in this version.',
  no_extractable_records:
    'Nothing could be extracted from the captured material, so there is nothing to assess.',
  pending_expired: 'The request waited too long for a worker and was cancelled. Nothing was spent.',
  worker_lease_expired: 'The worker stopped responding, so the run was ended. Nothing was scored.',
  worker_shutdown: 'The worker was shut down while the run was in progress.',
};

export function explainFailure(run: AssessmentRunView): string {
  const byCode = run.failureCode ? FAILURE_CODE_EXPLANATIONS[run.failureCode] : undefined;
  if (byCode !== undefined) return byCode;
  if (run.state === 'cancelled') return 'The run was cancelled before it finished.';
  return (
    (run.failureCategory ? FAILURE_EXPLANATIONS[run.failureCategory] : undefined) ??
    'The run did not complete. No assessment was produced.'
  );
}

// -- Relative highs and lows (P6B-alpha, DG-5 with safeguards) ------------------------------------------------------------------------

/*
 * A presentation of numbers the VERIFIED report already holds, nothing more. It compares this project's assessed dimensions with EACH
 * OTHER: it is not a threshold, not "strong"/"weak", not a comparison with other projects, and not uncertainty analysis. Insufficient
 * dimensions are never in the comparison (and never counted as zero); ties are all shown; fewer than two assessed dimensions, or all
 * assessed dimensions equal, produce an explicit "no comparison" result instead of an invented high or low.
 */

export interface RelativeEntry {
  readonly dimensionId: string;
  readonly name: string;
  readonly score10: number;
  /** The same score on the rubric's own scale. */
  readonly scoreOnScale: number;
  readonly confidence: number;
  /** The verified judgment of the dimension (citations, limitation codes), or null if the rows hold none. */
  readonly judgment: AssessmentJudgmentView | null;
}

export type RelativeDimensions =
  | { readonly kind: 'not_enough'; readonly assessed: number; readonly notAssessed: number }
  | {
      readonly kind: 'all_equal';
      readonly assessed: number;
      readonly notAssessed: number;
      readonly score10: number;
      readonly scoreOnScale: number;
    }
  | {
      readonly kind: 'ranked';
      readonly assessed: number;
      readonly notAssessed: number;
      readonly highest: readonly RelativeEntry[];
      readonly lowest: readonly RelativeEntry[];
    };

export function relativeDimensions(
  report: ScoreReport,
  judgments: readonly AssessmentJudgmentView[],
): RelativeDimensions {
  const byId = new Map(judgments.map((judgment) => [judgment.dimensionId, judgment]));
  const entries: RelativeEntry[] = [];
  let notAssessed = 0;
  for (const dimension of report.dimensions) {
    if (dimension.state !== 'assessed') {
      notAssessed += 1;
      continue;
    }
    entries.push({
      dimensionId: dimension.id,
      name: dimension.name,
      score10: dimension.score10,
      scoreOnScale: dimension.scoreOnScale,
      confidence: dimension.confidence,
      judgment: byId.get(dimension.id) ?? null,
    });
  }
  const assessed = entries.length;
  if (assessed < 2) return { kind: 'not_enough', assessed, notAssessed };
  const scores = entries.map((entry) => entry.score10);
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  if (max === min) {
    const first = entries[0];
    return {
      kind: 'all_equal',
      assessed,
      notAssessed,
      score10: max,
      scoreOnScale: first?.scoreOnScale ?? max,
    };
  }
  const byIdOrder = (a: RelativeEntry, b: RelativeEntry) =>
    a.dimensionId < b.dimensionId ? -1 : a.dimensionId > b.dimensionId ? 1 : 0;
  return {
    kind: 'ranked',
    assessed,
    notAssessed,
    highest: entries.filter((entry) => entry.score10 === max).sort(byIdOrder),
    lowest: entries.filter((entry) => entry.score10 === min).sort(byIdOrder),
  };
}

// -- Withheld-assessment guidance (P6B-alpha, D9) --------------------------------------------------------------------------------------

/*
 * What to tell an organizer when an assessment fails verification. The text depends only on the stable failure CODE: it never contains
 * stored content, and it never suggests the withheld numbers are "probably fine". Keys are checked for exhaustiveness against the verifier's
 * own lists in a test.
 */

const INTEGRITY_CHECK_FAILED =
  'This assessment failed an integrity check, so none of it is shown and it must not be relied on.';

export const WITHHELD_GUIDANCE: Readonly<Record<string, string>> = {
  text_hash: `${INTEGRITY_CHECK_FAILED} The stored report text no longer matches its checksum.`,
  schema: `${INTEGRITY_CHECK_FAILED} The stored report is not a valid report.`,
  output_hash: `${INTEGRITY_CHECK_FAILED} The stored report does not match the scoring engine’s own hash.`,
  stored_output_hash: `${INTEGRITY_CHECK_FAILED} The report hash recorded beside it does not match.`,
  canonical_fixed_point: `${INTEGRITY_CHECK_FAILED} The stored report is not in its canonical form.`,
  jsonb_mirror: `${INTEGRITY_CHECK_FAILED} The searchable copy of the report differs from the stored report.`,
  report_schema: `${INTEGRITY_CHECK_FAILED} The stored report could not be read as a valid report.`,
  judgment_mismatch_dimension_set: `${INTEGRITY_CHECK_FAILED} Its per-dimension records do not cover the same dimensions as the report.`,
  judgment_mismatch_dimension_duplicated: `${INTEGRITY_CHECK_FAILED} A dimension has more than one record.`,
  judgment_mismatch_outcome_state: `${INTEGRITY_CHECK_FAILED} A dimension’s record disagrees with the report about whether it was scored.`,
  judgment_mismatch_score: `${INTEGRITY_CHECK_FAILED} A dimension’s stored score disagrees with the report.`,
  judgment_mismatch_disposition: `${INTEGRITY_CHECK_FAILED} A dimension’s stored status disagrees with the report.`,
  judgment_mismatch_citations: `${INTEGRITY_CHECK_FAILED} A dimension’s cited evidence disagrees with the report.`,
  unverifiable: `${INTEGRITY_CHECK_FAILED} It could not be checked at all.`,
};

const WHAT_TO_DO =
  'What to do: the withheld record is kept unchanged and is not edited. Use “Reassess” to create a new version from the current material, and report this code to whoever runs the database so the cause can be found.';

export function withheldGuidance(code: string | null): { reason: string; action: string } {
  const reason =
    (code ? WITHHELD_GUIDANCE[code] : undefined) ??
    `${INTEGRITY_CHECK_FAILED} The check that failed is not recognized by this page.`;
  return { reason, action: WHAT_TO_DO };
}
