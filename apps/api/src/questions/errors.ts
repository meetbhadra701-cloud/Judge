export type QuestionApiErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'ASSESSMENT_NOT_FOUND'
  | 'QUESTION_SET_NOT_FOUND'
  | 'QUESTION_PROVIDER_NOT_CONFIGURED'
  | 'ASSESSMENT_NOT_VERIFIED'
  | 'QUESTION_INPUT_INCONSISTENT'
  | 'QUESTION_GENERATION_FAILED'
  | 'QUESTION_OUTPUT_INVALID'
  | 'QUESTION_SET_READ_ONLY'
  | 'PROJECT_VOIDED';

export const QUESTION_API_STATUS: Record<QuestionApiErrorCode, number> = {
  PROJECT_NOT_FOUND: 404,
  ASSESSMENT_NOT_FOUND: 404,
  QUESTION_SET_NOT_FOUND: 404,
  QUESTION_PROVIDER_NOT_CONFIGURED: 503,
  ASSESSMENT_NOT_VERIFIED: 409,
  QUESTION_INPUT_INCONSISTENT: 422,
  QUESTION_GENERATION_FAILED: 502,
  QUESTION_OUTPUT_INVALID: 502,
  QUESTION_SET_READ_ONLY: 405,
  PROJECT_VOIDED: 409,
};

/**
 * A typed, client-safe error of the question API. A set or an assessment of another project is reported exactly like a nonexistent one, so identifiers never
 * reveal objects of other projects. Details never echo request content, model output or project text.
 */
export class QuestionApiError extends Error {
  constructor(
    readonly code: QuestionApiErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'QuestionApiError';
  }
}
