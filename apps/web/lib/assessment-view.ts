import type {
  AssessmentCoverageSummary,
  AssessmentDetail,
  AssessmentJudgmentView,
  AssessmentListResponse,
  AssessmentRunView,
  ScoreReport,
} from '@judge-copilot/schemas';
import { missingExpectedSources } from '@judge-copilot/schemas';

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
/** What a recorded limitation means in plain words (only the ones whose code alone would mislead; any other code is shown as recorded). */
export const LIMITATION_EXPLANATIONS: Readonly<Record<string, string>> = {
  partial_score_excludes_model_declared_insufficient:
    'Part of the rubric weight was left out because the assessor itself declared those dimensions to lack evidence. That declaration was not independently reviewed, so the partial number may be higher than a full assessment would give. Treat it as a partial view, not as the project’s overall score.',
  newer_capture_unusable:
    'A newer attempt to capture this source failed or was rejected, so an older capture was assessed. This says nothing about the project and lowered no score.',
  organizer_supplied_source:
    'This text was typed or pasted by an organizer and was not fetched from, or compared with, the source.',
};

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

// -- Source coverage (P6B-beta3-R1) -----------------------------------------------------------------------------------------------------

/*
 * What the judge must be told about HOW MUCH of the project's evidence an assessment was built from. "Every rubric dimension received an
 * advisory score" (A) and "all of the project's evidence was examined" (B) are different statements; this module is the one place that
 * keeps them apart. It only describes the verified coverage record: it never computes a score, never says what the unexamined part contains
 * and never turns an unexamined part into a negative.
 */

export type CoverageLevel =
  /** A verified record with no coverage concern (by path-based heuristics only). */
  | 'no_concern'
  /** A verified record with at least one concern: some evidence was not examined. */
  | 'partial'
  /** A verified record whose verdict is insufficient. */
  | 'insufficient'
  /** An assessment from before coverage records existed, or a record that failed its checks: coverage is UNKNOWN. */
  | 'unknown';

export interface CoverageNotice {
  readonly level: CoverageLevel;
  /** True when nothing may be read as "all project evidence was examined". */
  readonly notAllExamined: boolean;
  /**
   * `known`: a verified record says what was examined (including that part was not). `unknown`: the record is missing, failed its checks or could
   * not be checked, so the page must say neither that the material was examined nor that it was not (P6D).
   */
  readonly knowledge: 'known' | 'unknown';
  /** Expected source types (GitHub, Devpost) that had no usable capture: missing evidence, never a low score. Empty when coverage is unknown. */
  readonly missingSources: readonly string[];
  readonly headline: string;
  /** What "complete" would NOT mean either: relevance and sufficiency are never established here. */
  readonly caveat: string;
  /** How the record was checked (verified records only): by re-running the selection over the stored source, never by trusting the record. */
  readonly checkedNote: string | null;
  /** Statement A, kept separate from B. */
  readonly dimensionsStatement: string;
  /** Plain-language account of the concerns, most important first. */
  readonly details: readonly string[];
  /** Conclusions this evidence cannot support, derived from the concerns. */
  readonly unsupported: readonly string[];
  readonly omitted: readonly {
    readonly component: string;
    readonly codePoints: number;
    readonly inspectedCodePoints: number;
  }[];
}

/** Plain words for why a stored coverage record was not trusted. Never says what the source contains. */
const PROBLEM_TEXT: Readonly<Record<string, string>> = {
  provenance_snapshot_mismatch:
    'The record describes the pinned captures differently from how they are actually stored.',
  provenance_artifact_mismatch:
    'The record names files, hashes or sizes that are not those of the stored source.',
  provenance_selection_mismatch:
    'The record says a different part of the source was shown than a fresh run of the selection yields.',
  provenance_measures_mismatch:
    'The record’s totals and verdict differ from what the stored source gives.',
  provenance_limitations_mismatch:
    'The record lists different limitations than the stored source gives.',
  provenance_budget_mismatch:
    'The record’s source allowance is not the one this run was made under.',
  provenance_policy_mismatch:
    'The record names a different selection policy than the run was frozen with.',
  provenance_run_mismatch: 'The record belongs to a different run than the one it is attached to.',
  provenance_unavailable:
    'The stored source could not be read, so the record could not be checked against it.',
  limitations_missing_from_assessment:
    'The assessment does not carry every limitation the record says reached the assessors.',
};

const CONCERN_TEXT: Readonly<Record<string, { detail: string; unsupported: string | null }>> = {
  no_implementation_shown: {
    detail: 'No implementation code was shown to the assessors.',
    unsupported: 'Anything about how the project is built or whether it works.',
  },
  implementation_mostly_unseen: {
    detail: 'Most of the implementation code was not shown.',
    unsupported: 'Conclusions about the implementation as a whole.',
  },
  implementation_components_unseen: {
    detail: 'Some implementation components were never shown.',
    unsupported: 'Anything about the components that were not shown.',
  },
  implementation_partially_seen: {
    detail: 'Some implementation components were shown only in part.',
    unsupported: 'Anything about the parts of those components that were not shown.',
  },
  dominant_component_unseen: {
    detail: 'The largest part of the implementation was not shown.',
    unsupported: 'Anything about the largest component, which is most of the code.',
  },
  largest_components_unseen: {
    detail: 'One or more of the three largest implementation components was not shown.',
    unsupported: 'Anything about those large components.',
  },
  generated_volume_large: {
    detail: 'A large share of the code looks generated or vendored (judged from file paths only).',
    unsupported: null,
  },
  duplicates_not_represented: {
    detail: 'Some byte-identical copies of files were not represented by a shown twin.',
    unsupported: null,
  },
  component_flood: {
    detail: 'The repository has an unusually large number of components.',
    unsupported: null,
  },
  documentation_partially_seen: {
    detail: 'Some documentation was shown only in part or not at all.',
    unsupported: 'Anything the unshown documentation says.',
  },
  documentation_category_unseen: {
    detail: 'A whole category of documentation was not shown.',
    unsupported: 'Anything that category of documentation says.',
  },
  configuration_partially_seen: {
    detail: 'Some configuration or deployment files were shown only in part.',
    unsupported: 'Anything about how the project is configured or deployed beyond what was shown.',
  },
  tests_partially_seen: {
    detail: 'Some test files were shown only in part.',
    unsupported: 'Anything about the testing that was not shown.',
  },
};

/** How an expected source type is named on the page. */
const SOURCE_TYPE_LABEL: Readonly<Record<string, string>> = {
  github: 'GitHub repository',
  devpost: 'Devpost submission',
};

const DIMENSIONS_SENTENCE = (assessed: number, total: number): string =>
  total === 0
    ? 'No rubric dimension received an advisory score.'
    : assessed === total
      ? `All ${String(total)} rubric dimensions received an advisory score.`
      : `${String(assessed)} of ${String(total)} rubric dimensions received an advisory score; the others have no number.`;

export function coverageNotice(detail: AssessmentDetail): CoverageNotice {
  const coverage = detail.coverage;
  const dimensions = detail.report?.dimensions ?? [];
  const dimensionsStatement = DIMENSIONS_SENTENCE(
    dimensions.filter((d) => d.state === 'assessed').length,
    dimensions.length,
  );
  const caveat =
    'Coverage is judged from file paths and sizes only. It cannot show that what was examined was relevant to a criterion, or that it was enough to judge it.';
  if (coverage.status === 'not_recorded' || !coverage.verified) {
    return {
      level: 'unknown',
      notAllExamined: true,
      knowledge: 'unknown',
      missingSources: [],
      headline:
        coverage.status === 'not_recorded'
          ? 'Source coverage was not recorded for this assessment. Do not read it as based on all of the project’s evidence.'
          : coverage.problems.length > 0 &&
              coverage.problems.every((code) => code === 'provenance_unavailable')
            ? 'The stored source-coverage record could not be checked against the stored source (the source could not be read), so how much of the project was examined is unknown. This is not evidence that anything was altered.'
            : 'The stored source-coverage record failed its integrity checks, so how much of the project was examined is unknown.',
      caveat,
      checkedNote: null,
      dimensionsStatement,
      details:
        coverage.status === 'not_recorded'
          ? [
              'This assessment was made before coverage was recorded. What the assessors were shown cannot be reconstructed from the stored data.',
            ]
          : coverage.problems.map(
              (code) => `${PROBLEM_TEXT[code] ?? 'Integrity check failed.'} (${code})`,
            ),
      unsupported: [
        'Any statement that all of the project’s evidence was examined.',
        'Any conclusion about a part of the project that cannot be shown to have been examined.',
      ],
      omitted: [],
    };
  }
  const concerns = coverage.concerns;
  const captured = coverage.snapshots.filter((s) => s.status === 'partial');
  const missing = missingExpectedSources(coverage.snapshots);
  const missingLabels = missing.map((type) => SOURCE_TYPE_LABEL[type]);
  const level: CoverageLevel =
    coverage.verdict === 'insufficient'
      ? 'insufficient'
      : concerns.length > 0 ||
          coverage.verdict === 'partial' ||
          captured.length > 0 ||
          missing.length > 0
        ? 'partial'
        : 'no_concern';
  const details = [
    ...missing.map(
      (type) =>
        `No usable capture of the project’s ${SOURCE_TYPE_LABEL[type]} was available to this assessment (it was never captured, or its capture failed). Nothing about it was examined. This is missing evidence, not a finding against the project, and no score was lowered for it.`,
    ),
    ...concerns.map((code) => CONCERN_TEXT[code]?.detail ?? `Coverage concern: ${code}.`),
    ...captured.map(
      (s) =>
        `The ${s.sourceType} capture itself was partial (${s.partialReasons.join(', ') || 'reason not stated'}): material beyond the capture limits was never obtained.`,
    ),
  ];
  const measures = coverage.measures;
  if (measures !== null && measures.implementation.files > 0) {
    details.push(
      `Implementation inspected: ${String(measures.implementation.filesShown + measures.implementation.filesRepresented)} of ${String(measures.implementation.files)} files, ${formatRatio(measures.implementation.inspectedShare)} of its code; ${String(measures.components.withShownFile)} of ${String(measures.components.total)} components had a file shown.`,
    );
  }
  const unsupported = [
    ...new Set(
      concerns.flatMap((code) => {
        const text = CONCERN_TEXT[code]?.unsupported;
        return text === null || text === undefined ? [] : [text];
      }),
    ),
  ];
  if (captured.length > 0) {
    unsupported.push('Anything about the material the partial capture never obtained.');
  }
  for (const label of missingLabels)
    unsupported.push(`Anything about the project’s ${label}, which was not available.`);
  const notAllExamined = level !== 'no_concern';
  const onlyMissing =
    missing.length > 0 &&
    concerns.length === 0 &&
    captured.length === 0 &&
    coverage.verdict !== 'partial';
  return {
    level,
    notAllExamined,
    knowledge: 'known',
    missingSources: missing,
    headline:
      level === 'insufficient'
        ? 'SOURCE COVERAGE INSUFFICIENT — too little of the project was examined for these scores to say much about it.'
        : onlyMissing
          ? `EXPECTED SOURCE MISSING — no usable capture of the project’s ${missingLabels.join(' or ')} was available. The coverage below describes only the material that was available.`
          : notAllExamined
            ? 'PARTIAL SOURCE COVERAGE — not all of the project’s evidence was examined.'
            : 'No source-coverage concern was found by the path-based checks.',
    caveat,
    checkedNote:
      coverage.provenance === null
        ? null
        : coverage.provenance.budgets === 'pinned_by_extraction'
          ? 'This record was checked by running the selection again over the stored source text, under the run’s frozen settings; it matches exactly.'
          : 'This record was checked by running the selection again over the stored source text; it matches exactly. The run stopped before any extraction existed, so its source allowance is only shown to be one the settings allow.',
    dimensionsStatement,
    details,
    unsupported,
    omitted: coverage.omittedComponents.map((c) => ({
      component: c.component,
      codePoints: c.codePoints,
      inspectedCodePoints: c.inspectedCodePoints,
    })),
  };
}

/** The qualifier that must accompany any scored headline or version row: a number is never shown as "complete" evidence by itself. */
export function coverageQualifier(coverage: AssessmentCoverageSummary): string {
  if (coverage.status === 'not_recorded') return 'source coverage not recorded';
  if (!coverage.verified) return 'source coverage unverified';
  if (coverage.verdict === 'insufficient') return 'source coverage insufficient';
  if (coverage.missingSources.length > 0) return 'expected source missing';
  if (coverage.verdict === 'partial' || coverage.concerns.length > 0 || coverage.partialCapture) {
    return 'partial source coverage';
  }
  return 'no source-coverage concern';
}
