export type SourceIngestionErrorCode =
  | 'EVENT_NOT_FOUND'
  | 'PROJECT_NOT_FOUND'
  | 'SOURCE_NOT_FOUND'
  | 'SNAPSHOT_NOT_FOUND'
  | 'ARTIFACT_NOT_FOUND'
  | 'NO_LOCKED_CONTEXT'
  | 'PROJECT_NAME_TAKEN'
  | 'DUPLICATE_SOURCE'
  | 'CAPTURE_ALREADY_PENDING'
  | 'SNAPSHOT_IMMUTABLE'
  | 'SOURCE_IMMUTABLE'
  | 'UNKNOWN_TRACK'
  | 'INVALID_SOURCE_URL'
  | 'SOURCE_LIMIT_REACHED';

export const SOURCE_INGESTION_STATUS: Record<SourceIngestionErrorCode, number> = {
  EVENT_NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  SOURCE_NOT_FOUND: 404,
  SNAPSHOT_NOT_FOUND: 404,
  ARTIFACT_NOT_FOUND: 404,
  NO_LOCKED_CONTEXT: 409,
  PROJECT_NAME_TAKEN: 409,
  DUPLICATE_SOURCE: 409,
  CAPTURE_ALREADY_PENDING: 409,
  SNAPSHOT_IMMUTABLE: 405,
  SOURCE_IMMUTABLE: 405,
  UNKNOWN_TRACK: 422,
  INVALID_SOURCE_URL: 422,
  SOURCE_LIMIT_REACHED: 422,
};

/** A typed, client-safe error of the project-source workflow. Details never echo raw input. */
export class SourceIngestionError extends Error {
  constructor(
    readonly code: SourceIngestionErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SourceIngestionError';
  }
}
