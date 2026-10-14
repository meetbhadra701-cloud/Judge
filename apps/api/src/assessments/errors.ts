export type AssessmentApiErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'ASSESSMENT_NOT_FOUND'
  | 'ASSESSMENT_RUN_NOT_FOUND'
  | 'ASSESSMENT_PROVIDER_NOT_CONFIGURED'
  | 'ASSESSMENT_RUN_ACTIVE'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'NO_LOCKED_CONTEXT'
  | 'NO_SOURCE_SNAPSHOTS'
  | 'ASSESSMENT_READ_ONLY'
  | 'PROJECT_VOIDED';

export const ASSESSMENT_API_STATUS: Record<AssessmentApiErrorCode, number> = {
  PROJECT_NOT_FOUND: 404,
  ASSESSMENT_NOT_FOUND: 404,
  ASSESSMENT_RUN_NOT_FOUND: 404,
  ASSESSMENT_PROVIDER_NOT_CONFIGURED: 503,
  ASSESSMENT_RUN_ACTIVE: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
  NO_LOCKED_CONTEXT: 409,
  NO_SOURCE_SNAPSHOTS: 422,
  ASSESSMENT_READ_ONLY: 405,
  PROJECT_VOIDED: 409,
};

/**
 * A typed, client-safe error of the assessment API. An assessment or run of another project is reported exactly like a nonexistent
 * one, so identifiers never reveal objects of other projects. Details never echo request content.
 */
export class AssessmentApiError extends Error {
  constructor(
    readonly code: AssessmentApiErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AssessmentApiError';
  }
}
