export type EvidenceGraphApiErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'CLAIM_NOT_FOUND'
  | 'EVIDENCE_NOT_FOUND'
  | 'NODE_NOT_FOUND'
  | 'GRAPH_READ_ONLY';

export const EVIDENCE_GRAPH_API_STATUS: Record<EvidenceGraphApiErrorCode, number> = {
  PROJECT_NOT_FOUND: 404,
  CLAIM_NOT_FOUND: 404,
  EVIDENCE_NOT_FOUND: 404,
  NODE_NOT_FOUND: 404,
  GRAPH_READ_ONLY: 405,
};

/**
 * A typed, client-safe error of the evidence graph read API. A reference into another project
 * is reported exactly like a nonexistent one, so IDs never reveal objects of other projects.
 */
export class EvidenceGraphApiError extends Error {
  constructor(
    readonly code: EvidenceGraphApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EvidenceGraphApiError';
  }
}
