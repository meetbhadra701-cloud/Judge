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
      if (snapshot.provenance === 'organizer_supplied') {
        return {
          stage: 'captured',
          label: 'TEXT SUPPLIED BY AN ORGANIZER',
          detail:
            'An organizer typed or pasted this text and it was stored as an immutable snapshot. It was NOT fetched from the source and has not been compared with it. It is not an analysis, and it does not verify anything.',
          gaps: [],
          retryable: true,
          hasContent: true,
        };
      }
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
      if (snapshot.failureReason === 'cancelled_by_void') {
        return {
          stage: 'failed',
          label: 'CAPTURE CANCELLED',
          detail:
            'This capture was cancelled, before any worker started it, when the project was voided. Nothing was read from the source and nothing was captured.',
          gaps: [],
          retryable: false,
          hasContent: false,
        };
      }
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

/**
 * A short string that changes exactly when something the capture page shows could have changed: which snapshot is the latest of each
 * source, and its status. The page's progress checker compares it, so the page is re-rendered only on a real change.
 */
export function captureFingerprint(project: {
  readonly sources: readonly ProjectSourceRecord[];
}): string {
  return project.sources
    .map(
      (source) =>
        `${source.id}:${source.latestSnapshot?.id ?? 'none'}:${source.latestSnapshot?.status ?? 'none'}`,
    )
    .join('|');
}

/**
 * A warning for a project whose declared sources cannot belong to ONE submission: more than one GitHub link or more than one Devpost link.
 * Such projects come from the flow before submission records existed (R7-1). Nothing is rewritten; the page just refuses to let the project
 * look like a single clean submission. Null when the sources are consistent.
 */
export function sourceIntegrityNotice(sources: readonly ProjectSourceRecord[]): string | null {
  const count = (type: string) => sources.filter((source) => source.sourceType === type).length;
  const github = count('github');
  const devpost = count('devpost');
  if (github <= 1 && devpost <= 1) return null;
  return `This project does not form a single submission: it declares ${String(github)} GitHub link${github === 1 ? '' : 's'} and ${String(devpost)} Devpost link${devpost === 1 ? '' : 's'}. Its captures and any assessment mix the material of more than one submission, so do not rely on them. Nothing was changed or deleted. Submit each GitHub + Devpost pair on its own (see “Mixed projects” in docs/DEMO_RUNBOOK.md).`;
}
