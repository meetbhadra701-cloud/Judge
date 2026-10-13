import type {
  CaptureFailureCategory,
  CapturePartialReason,
  ProjectSourceRecord,
  SnapshotSummary,
} from '@judge-copilot/schemas';

/*
 * How a source's latest capture is explained to a person (P6B-alpha). Capturing a source is NOT analysing it: a `captured` snapshot means
 * the page or repository text was stored, nothing more. The maps are exhaustive over the schema vocabularies (a new category or reason is
 * a compile error here, so an unexplained failure code can never reach the page), and the texts never claim that the live site was
 * verified, that the project is good, or that any AI analysis happened.
 */

export const FAILURE_TEXT: Readonly<Record<CaptureFailureCategory, string>> = {
  invalid_url: 'The URL could not be used.',
  unsupported_source: 'This kind of source cannot be captured.',
  ssrf_rejected: 'The address was refused by the safety policy (it is not a public web address).',
  too_many_redirects: 'The site redirected too many times.',
  dns_failure: 'The host name could not be resolved.',
  timeout: 'The site did not answer in time.',
  tls_failure: 'The secure connection could not be established.',
  connection_failure: 'The connection to the site failed.',
  response_too_large: 'The response was larger than the capture limit.',
  unsupported_content_type: 'The site answered with a type of content that cannot be captured.',
  http_api_error: 'The site or API answered with an error.',
  rate_limited: 'The site is limiting requests right now. Try again later.',
  not_found: 'Nothing was found at this address (it may be private, renamed or removed).',
  parse_failure: 'The page was received but its structure could not be read.',
  internal_error: 'An internal error stopped the capture.',
};

export const PARTIAL_TEXT: Readonly<Record<CapturePartialReason, string>> = {
  tree_truncated: 'the repository file list was cut off by the host',
  tree_entry_limit: 'the repository has more files than the capture limit',
  commit_limit: 'only the most recent commits were read',
  file_size_limit: 'some files were too large to read',
  file_count_limit: 'only part of the files were read',
  total_text_limit: 'the total text limit was reached',
  blob_unavailable: 'some files could not be downloaded',
  time_budget_exhausted: 'the time budget ran out',
  body_truncated: 'the page body was cut at the size limit',
  body_not_captured: 'the page body was not captured',
  sections_missing: 'some expected page sections were not found',
  html_structure_limit: 'the page structure exceeded the reading limit',
  generic_metadata_only: 'only generic page information could be read',
};

export type CaptureStage =
  'not_requested' | 'waiting' | 'captured' | 'captured_partial' | 'failed' | 'rejected';

export interface CaptureStatusView {
  readonly stage: CaptureStage;
  readonly label: string;
  /** What this means, in one sentence; never implies analysis. */
  readonly detail: string;
  /** Plain-language reasons the capture is incomplete (partial) — empty otherwise. */
  readonly gaps: readonly string[];
  readonly retryable: boolean;
  /** True when a content-bearing snapshot exists (the minimum for an assessment to have anything to read). */
  readonly hasContent: boolean;
}

export function describeCapture(snapshot: SnapshotSummary | null): CaptureStatusView {
  if (snapshot === null) {
    return {
      stage: 'not_requested',
      label: 'NOT CAPTURED YET',
      detail: 'No capture has been requested for this source.',
      gaps: [],
      retryable: true,
      hasContent: false,
    };
  }
  switch (snapshot.status) {
    case 'pending':
      return {
        stage: 'waiting',
        label: 'WAITING FOR THE CAPTURE WORKER',
        detail: 'The capture is queued. Nothing has been read from this source yet.',
        gaps: [],
        retryable: false,
        hasContent: false,
      };
    case 'captured':
      return {
        stage: 'captured',
        label: 'CAPTURED',
        detail:
          'The source text was stored as an immutable snapshot. This is not an analysis, and it does not verify that the project works.',
        gaps: [],
        retryable: false,
        hasContent: true,
      };
    case 'partial':
      return {
        stage: 'captured_partial',
        label: 'CAPTURED (PARTIAL)',
        detail:
          'Part of the source was stored. What is missing is missing, not negative evidence about the project.',
        gaps: snapshot.partialReasons.map((reason) => PARTIAL_TEXT[reason]),
        retryable: true,
        hasContent: true,
      };
    case 'failed':
      return {
        stage: 'failed',
        label: 'CAPTURE FAILED',
        detail:
          snapshot.failureCategory === null
            ? 'The capture failed.'
            : FAILURE_TEXT[snapshot.failureCategory],
        gaps: [],
        retryable: true,
        hasContent: false,
      };
    case 'rejected':
      return {
        stage: 'rejected',
        label: 'CAPTURE REFUSED',
        detail:
          snapshot.failureCategory === null
            ? 'The capture was refused by the safety policy.'
            : FAILURE_TEXT[snapshot.failureCategory],
        gaps: [],
        retryable: true,
        hasContent: false,
      };
  }
}

export interface CaptureOverview {
  /** At least one source is still waiting for the worker: the page should refresh itself. */
  readonly anyWaiting: boolean;
  readonly anyFailed: boolean;
  readonly anyContent: boolean;
  /** Every declared source has a content-bearing snapshot. */
  readonly allContent: boolean;
}

export function overviewOf(sources: readonly ProjectSourceRecord[]): CaptureOverview {
  const views = sources.map((source) => describeCapture(source.latestSnapshot));
  return {
    anyWaiting: views.some((view) => view.stage === 'waiting'),
    anyFailed: views.some((view) => view.stage === 'failed' || view.stage === 'rejected'),
    anyContent: views.some((view) => view.hasContent),
    allContent: views.length > 0 && views.every((view) => view.hasContent),
  };
}
