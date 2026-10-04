import type { EventContextIssue } from '@judge-copilot/schemas';

export const EVENT_CONTEXT_ISSUE_CODES = [
  'UNKNOWN_SOURCE_REFERENCE',
  'CROSS_EVENT_REFERENCE',
  'MISSING_PROVENANCE',
  'PROVENANCE_REMOVED',
  'UNKNOWN_FACT_ID',
  'DUPLICATE_FACT_ID',
  'INVALID_DATE_ORDER',
  'DUPLICATE_TRACK_KEY',
  'UNKNOWN_TRACK_REFERENCE',
  'INVALID_RUBRIC_SCOPE',
  'DUPLICATE_RUBRIC',
  'EMPTY_RUBRIC',
  'INVALID_RUBRIC_SCALE',
  'DUPLICATE_CRITERION_KEY',
  'INVALID_RUBRIC_WEIGHTS',
  'INVALID_CONFLICT',
  'INVALID_CONFLICT_RESOLUTION',
  'CONTEXT_CONTENT_MISSING',
] as const;
export type EventContextIssueCode = (typeof EVENT_CONTEXT_ISSUE_CODES)[number];

export const EVENT_CONTEXT_OPERATION_CODES = [
  'EVENT_NOT_FOUND',
  'EVENT_SLUG_TAKEN',
  'CONTEXT_VERSION_NOT_FOUND',
  'NO_LOCKED_CONTEXT',
  'CONTEXT_NOT_DRAFT',
  'LOCKED_CONTEXT_IMMUTABLE',
  'STALE_CONTEXT_BASE',
  'CHANGE_REASON_REQUIRED',
  'NO_CONTEXT_SOURCES',
  'SOURCE_LIMIT_REACHED',
  'INVALID_SOURCE_TEXT',
  'EXTRACTOR_NOT_CONFIGURED',
  'CONTEXT_BUILD_FAILED',
  'HUMAN_EDITS_WOULD_BE_REPLACED',
  'CONTEXT_BUILD_STALE',
] as const;
export type EventContextOperationCode = (typeof EVENT_CONTEXT_OPERATION_CODES)[number];

export type EventContextErrorCode = EventContextIssueCode | EventContextOperationCode;

export interface TypedIssue extends EventContextIssue {
  code: EventContextIssueCode;
}

/** A typed, user-safe domain error. Messages never contain source text or secrets. */
export class EventContextError extends Error {
  readonly code: EventContextErrorCode;
  readonly issues: readonly TypedIssue[];
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: EventContextErrorCode,
    message: string,
    options: { issues?: readonly TypedIssue[]; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'EventContextError';
    this.code = code;
    this.issues = options.issues ?? [];
    this.details = options.details ?? {};
  }
}

/** Throws when `issues` is non-empty; the error code is the first issue's code. */
export function throwIfIssues(issues: readonly TypedIssue[]): void {
  const [first] = issues;
  if (first) {
    throw new EventContextError(first.code, first.message, { issues });
  }
}

export function issue(code: EventContextIssueCode, path: string, message: string): TypedIssue {
  return { code, path, message };
}
