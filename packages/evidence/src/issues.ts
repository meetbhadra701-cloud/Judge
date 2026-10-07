/*
 * Typed, stable issue codes for everything the evidence graph validates. Messages describe rules
 * and never echo project text. Issues are plain data so apps can map them to HTTP and tests can
 * assert on codes.
 */

export const GRAPH_ISSUE_CODES = [
  // batch structure
  'DUPLICATE_LOCAL_REF',
  'LOCAL_REF_NOT_FOUND',
  'FORWARD_SUPERSESSION',
  'DUPLICATE_REFERENCE',
  'PROJECT_LIMIT_EXCEEDED',
  // reference integrity (invariant 20: the model never invents IDs)
  'CLAIM_NOT_FOUND',
  'EVIDENCE_NOT_FOUND',
  'SNAPSHOT_NOT_FOUND',
  'ARTIFACT_NOT_FOUND',
  'CONTEXT_VERSION_NOT_FOUND',
  'WRONG_ENTITY_TYPE',
  'CROSS_PROJECT_REFERENCE',
  'DANGLING_REFERENCE',
  // provenance
  'ORIGIN_NOT_SUPPORTED',
  'MISSING_PROVENANCE',
  'UNEXPECTED_PROVENANCE',
  'MISSING_ANCHOR',
  'CONTEXT_VERSION_NOT_FROZEN',
  'SNAPSHOT_NOT_CONTENT_BEARING',
  'SOURCE_TYPE_MISMATCH',
  'ARTIFACT_SNAPSHOT_MISMATCH',
  'SPAN_INVALID',
  'SPAN_OUT_OF_BOUNDS',
  'EXCERPT_MISMATCH',
  // verification
  'INVALID_VERIFICATION',
  'VERIFICATION_NOT_AVAILABLE',
  'ARTIFACT_NOT_CORROBORATING',
  'UNJUSTIFIED_VERIFICATION',
  'INVALID_VERIFICATION_TRANSITION',
  // claims
  'CLAIM_ALREADY_SUPERSEDED',
  'SUPERSESSION_CYCLE',
  // relations, unknowns, contradictions
  'DUPLICATE_RELATION',
  'CONFLICTING_RELATION',
  'RELATION_KIND_NOT_ALLOWED',
  'CONTRADICTION_SAME_SIDE',
  'DUPLICATE_CONTRADICTION',
  'CONTRADICTION_KIND_NOT_ALLOWED',
] as const;
export type GraphIssueCode = (typeof GRAPH_ISSUE_CODES)[number];

export interface GraphIssue {
  readonly code: GraphIssueCode;
  /** Where: a batch path such as `relations[2].evidence`, or `claim:<id>` for a persisted record. */
  readonly path: string;
  readonly message: string;
}

/** Deterministic order: by path, then code (plain string comparison, never locale-aware). */
export function sortIssues(issues: readonly GraphIssue[]): GraphIssue[] {
  return [...issues].sort((a, b) =>
    a.path === b.path ? compareStrings(a.code, b.code) : compareStrings(a.path, b.path),
  );
}

/** Locale-independent string comparison (UTF-16 code unit order). */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Thrown by trusted code when a batch or a loaded graph violates the graph rules. */
export class EvidenceGraphError extends Error {
  constructor(
    readonly issues: readonly GraphIssue[],
    message = 'The evidence graph is invalid',
  ) {
    super(message);
    this.name = 'EvidenceGraphError';
  }

  get codes(): GraphIssueCode[] {
    return this.issues.map((issue) => issue.code);
  }
}

/** A batch that failed schema validation (shape, bounds, forbidden keys such as smuggled IDs). */
export class EvidenceGraphInputError extends Error {
  constructor(readonly issues: readonly { path: string; message: string }[]) {
    super('The evidence graph batch is malformed');
    this.name = 'EvidenceGraphInputError';
  }
}

/**
 * Persistence failed for a reason the planner cannot predict (for example a race that the
 * database constraints caught). Carries only a SQLSTATE and constraint name: driver errors embed
 * bound parameters, which here are untrusted project text, so they are never propagated.
 */
export class EvidenceGraphPersistenceError extends Error {
  constructor(
    readonly sqlState: string | null,
    readonly constraint: string | null,
  ) {
    super('The evidence graph could not be persisted');
    this.name = 'EvidenceGraphPersistenceError';
  }
}
