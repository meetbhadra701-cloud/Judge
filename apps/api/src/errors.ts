import { EventContextError, type EventContextErrorCode } from '@judge-copilot/context';
import type { ApiErrorBody } from '@judge-copilot/schemas';
import { ASSESSMENT_API_STATUS, AssessmentApiError } from './assessments/errors.js';
import { INTERVIEW_API_STATUS, InterviewApiError } from './interview/errors.js';
import { QUESTION_API_STATUS, QuestionApiError } from './questions/errors.js';
import { AUTH_STATUS, AuthError } from './auth.js';
import { EVIDENCE_GRAPH_API_STATUS, EvidenceGraphApiError } from './evidence-graph/errors.js';
import { RequestValidationError, type ApiApp } from './http.js';
import { SOURCE_INGESTION_STATUS, SourceIngestionError } from './projects/errors.js';

const STATUS_BY_CODE: Record<EventContextErrorCode, number> = {
  EVENT_NOT_FOUND: 404,
  CONTEXT_VERSION_NOT_FOUND: 404,
  NO_LOCKED_CONTEXT: 404,
  EVENT_SLUG_TAKEN: 409,
  CONTEXT_NOT_DRAFT: 409,
  LOCKED_CONTEXT_IMMUTABLE: 409,
  STALE_CONTEXT_BASE: 409,
  HUMAN_EDITS_WOULD_BE_REPLACED: 409,
  CONTEXT_BUILD_STALE: 409,
  EXTRACTOR_NOT_CONFIGURED: 503,
  CHANGE_REASON_REQUIRED: 422,
  NO_CONTEXT_SOURCES: 422,
  SOURCE_LIMIT_REACHED: 422,
  INVALID_SOURCE_TEXT: 422,
  CONTEXT_BUILD_FAILED: 422,
  UNKNOWN_SOURCE_REFERENCE: 422,
  CROSS_EVENT_REFERENCE: 422,
  MISSING_PROVENANCE: 422,
  PROVENANCE_REMOVED: 422,
  UNKNOWN_FACT_ID: 422,
  DUPLICATE_FACT_ID: 422,
  INVALID_DATE_ORDER: 422,
  DUPLICATE_TRACK_KEY: 422,
  UNKNOWN_TRACK_REFERENCE: 422,
  INVALID_RUBRIC_SCOPE: 422,
  DUPLICATE_RUBRIC: 422,
  EMPTY_RUBRIC: 422,
  INVALID_RUBRIC_SCALE: 422,
  DUPLICATE_CRITERION_KEY: 422,
  INVALID_RUBRIC_WEIGHTS: 422,
  INVALID_CONFLICT: 422,
  INVALID_CONFLICT_RESOLUTION: 422,
  CONTEXT_CONTENT_MISSING: 422,
  UNOFFICIAL_EXPLICIT_STATEMENT: 422,
  UNSOURCED_OFFICIAL_RUBRIC: 422,
};

function hasPgCode(error: unknown, codes: readonly string[]): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && codes.includes(code)) return true;
  }
  return false;
}

export function httpStatusFor(code: EventContextErrorCode): number {
  return STATUS_BY_CODE[code];
}

function body(code: string, message: string, details?: Record<string, unknown>): ApiErrorBody {
  return { error: details ? { code, message, details } : { code, message } };
}

/**
 * Typed errors map to stable codes and HTTP statuses. Unexpected errors become a generic 500;
 * their details go only to the (redacting) logger, never to the client.
 */
export function installErrorHandling(app: ApiApp): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof EventContextError) {
      const details = {
        ...error.details,
        ...(error.issues.length > 0 ? { issues: error.issues } : {}),
      };
      return reply
        .code(httpStatusFor(error.code))
        .send(
          body(error.code, error.message, Object.keys(details).length > 0 ? details : undefined),
        );
    }
    if (error instanceof AuthError) {
      if (error.code === 'UNAUTHENTICATED') void reply.header('www-authenticate', 'Bearer');
      return reply.code(AUTH_STATUS[error.code]).send(body(error.code, error.message));
    }
    if (error instanceof SourceIngestionError) {
      return reply
        .code(SOURCE_INGESTION_STATUS[error.code])
        .send(
          body(
            error.code,
            error.message,
            Object.keys(error.details).length > 0 ? error.details : undefined,
          ),
        );
    }
    if (error instanceof EvidenceGraphApiError) {
      return reply
        .code(EVIDENCE_GRAPH_API_STATUS[error.code])
        .send(body(error.code, error.message));
    }
    if (error instanceof AssessmentApiError) {
      return reply
        .code(ASSESSMENT_API_STATUS[error.code])
        .send(
          body(
            error.code,
            error.message,
            Object.keys(error.details).length > 0 ? error.details : undefined,
          ),
        );
    }
    if (error instanceof QuestionApiError) {
      const retryAfterMs = error.details['retryAfterMs'];
      if (typeof retryAfterMs === 'number' && retryAfterMs >= 0) {
        void reply.header('retry-after', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      }
      return reply
        .code(QUESTION_API_STATUS[error.code])
        .send(
          body(
            error.code,
            error.message,
            Object.keys(error.details).length > 0 ? error.details : undefined,
          ),
        );
    }
    if (error instanceof InterviewApiError) {
      return reply
        .code(INTERVIEW_API_STATUS[error.code])
        .send(
          body(
            error.code,
            error.message,
            Object.keys(error.details).length > 0 ? error.details : undefined,
          ),
        );
    }
    if (error instanceof RequestValidationError) {
      return reply.code(400).send(
        body('INVALID_REQUEST', `Invalid request ${error.location}`, {
          location: error.location,
          issues: error.issues,
        }),
      );
    }
    // Text the database cannot store (a NUL character, invalid UTF-8) is the caller's input, never a server fault. Request schemas already refuse
    // control characters in labels; this is the backstop for any path that reaches the database with such text.
    if (hasPgCode(error, ['22021', '22P05'])) {
      return reply
        .code(422)
        .send(body('INVALID_REQUEST', 'The request contains text that cannot be stored'));
    }
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return statusCode === 413
        ? reply.code(413).send(body('PAYLOAD_TOO_LARGE', 'The request body is too large'))
        : reply
            .code(statusCode)
            .send(body('INVALID_REQUEST', 'The request could not be processed'));
    }
    request.log.error({ err: error }, 'unhandled request error');
    return reply.code(500).send(body('INTERNAL_ERROR', 'Internal server error'));
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(body('NOT_FOUND', 'Route not found')),
  );
}
