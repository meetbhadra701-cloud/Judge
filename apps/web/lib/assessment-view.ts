import type {
  AssessmentDetail,
  AssessmentListResponse,
  AssessmentRunView,
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

export function formatScore10(value: number): string {
  return value.toFixed(1);
}

export function formatRatio(value: number): string {
  return `${String(Math.round(value * 100))}%`;
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

export function explainFailure(run: AssessmentRunView): string {
  if (run.state === 'cancelled') return 'The run was cancelled before it finished.';
  return (
    (run.failureCategory ? FAILURE_EXPLANATIONS[run.failureCategory] : undefined) ??
    'The run did not complete. No assessment was produced.'
  );
}
