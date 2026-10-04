import { EventContextError, type EventContextErrorCode } from '@judge-copilot/context';
import type { ApiErrorBody } from '@judge-copilot/schemas';
import { RequestValidationError, type ApiApp } from './http.js';

const STATUS_BY_CODE: Record<EventContextErrorCode, number> = {
  EVENT_NOT_FOUND: 404,
  CONTEXT_VERSION_NOT_FOUND: 404,
  NO_LOCKED_CONTEXT: 404,
  EVENT_SLUG_TAKEN: 409,
  CONTEXT_NOT_DRAFT: 409,
  LOCKED_CONTEXT_IMMUTABLE: 409,
  STALE_CONTEXT_BASE: 409,
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
};

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
    if (error instanceof RequestValidationError) {
      return reply.code(400).send(
        body('INVALID_REQUEST', `Invalid request ${error.location}`, {
          location: error.location,
          issues: error.issues,
        }),
      );
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
