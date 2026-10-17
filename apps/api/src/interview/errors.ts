export type InterviewApiErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'ASSESSMENT_NOT_FOUND'
  | 'QUESTION_SET_NOT_FOUND'
  | 'QUESTION_NOT_FOUND'
  | 'INTERVIEW_RECORD_NOT_FOUND'
  | 'ASSESSMENT_NOT_VERIFIED'
  | 'INTERVIEW_TARGET_MISMATCH'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INTERVIEW_ALREADY_CORRECTED'
  | 'PROJECT_VOIDED'
  | 'INTERVIEW_RECORDS_IMMUTABLE';

export const INTERVIEW_API_STATUS: Record<InterviewApiErrorCode, number> = {
  PROJECT_NOT_FOUND: 404,
  ASSESSMENT_NOT_FOUND: 404,
  QUESTION_SET_NOT_FOUND: 404,
  QUESTION_NOT_FOUND: 404,
  INTERVIEW_RECORD_NOT_FOUND: 404,
  ASSESSMENT_NOT_VERIFIED: 409,
  /** The named records exist but do not belong together (a question outside its set, a set of another assessment, an answer to another question). */
  INTERVIEW_TARGET_MISMATCH: 422,
  IDEMPOTENCY_KEY_REUSED: 409,
  /** The record to correct already has a correction: only the newest record of a chain can be corrected. */
  INTERVIEW_ALREADY_CORRECTED: 409,
  PROJECT_VOIDED: 409,
  INTERVIEW_RECORDS_IMMUTABLE: 405,
};

/**
 * A typed, client-safe error of the interview API. An object of another project is reported exactly like a nonexistent one, so identifiers never reveal anything
 * about other projects. Details never echo request content: no answer, observation or other typed text is ever put in an error.
 */
export class InterviewApiError extends Error {
  constructor(
    readonly code: InterviewApiErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'InterviewApiError';
  }
}
