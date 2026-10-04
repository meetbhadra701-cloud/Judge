import { z } from 'zod';

/*
 * Vocabularies and limits for M2 project-source ingestion. Like enums.ts, each vocabulary is a
 * readonly tuple (reused by database CHECK constraints) plus a Zod enum. Project material is
 * untrusted input: these values describe *how* it was captured, never what it is worth.
 */

/** The kinds of project source a team can declare. */
export const PROJECT_SOURCE_TYPE_VALUES = ['devpost', 'github', 'deployment', 'video'] as const;
export const ProjectSourceType = z.enum(PROJECT_SOURCE_TYPE_VALUES);
export type ProjectSourceType = z.infer<typeof ProjectSourceType>;

/**
 * Why a capture ended `failed` or `rejected`. Sanitized categories only: never a raw error,
 * response body, header or credential. Which categories mean `rejected` (refused by policy, not
 * negative evidence) is defined in @judge-copilot/domain (`CAPTURE_REJECTION_CATEGORIES`).
 */
export const CAPTURE_FAILURE_CATEGORY_VALUES = [
  'invalid_url',
  'unsupported_source',
  'ssrf_rejected',
  'too_many_redirects',
  'dns_failure',
  'timeout',
  'tls_failure',
  'connection_failure',
  'response_too_large',
  'unsupported_content_type',
  'http_api_error',
  'rate_limited',
  'not_found',
  'parse_failure',
  'internal_error',
] as const;
export const CaptureFailureCategory = z.enum(CAPTURE_FAILURE_CATEGORY_VALUES);
export type CaptureFailureCategory = z.infer<typeof CaptureFailureCategory>;

/** Why a capture is `partial`: a deterministic limit or an explicit gap, never silent truncation. */
export const CAPTURE_PARTIAL_REASON_VALUES = [
  'tree_truncated',
  'tree_entry_limit',
  'commit_limit',
  'file_size_limit',
  'file_count_limit',
  'total_text_limit',
  'blob_unavailable',
  'time_budget_exhausted',
  'body_truncated',
  'body_not_captured',
  'sections_missing',
  'generic_metadata_only',
] as const;
export const CapturePartialReason = z.enum(CAPTURE_PARTIAL_REASON_VALUES);
export type CapturePartialReason = z.infer<typeof CapturePartialReason>;

/** What a snapshot artifact holds. Every artifact is bounded UTF-8 text with its own SHA-256. */
export const SNAPSHOT_ARTIFACT_KIND_VALUES = [
  'repository_metadata',
  'commit_history',
  'tree',
  'file',
  'omissions',
  'submission',
  'submission_text',
  'http_response',
  'page_metadata',
  'page_text',
  'video_metadata',
] as const;
export const SnapshotArtifactKind = z.enum(SNAPSHOT_ARTIFACT_KIND_VALUES);
export type SnapshotArtifactKind = z.infer<typeof SnapshotArtifactKind>;

/** Roles an authenticated actor may hold. Authorization rules live in @judge-copilot/domain. */
export const ACTOR_ROLE_VALUES = ['organizer', 'judge'] as const;
export const ActorRole = z.enum(ACTOR_ROLE_VALUES);
export type ActorRole = z.infer<typeof ActorRole>;

/** Hard storage limits shared by validation and database CHECK constraints. */
export const SOURCE_INGESTION_LIMITS = {
  projectNameMaxChars: 200,
  teamNameMaxChars: 200,
  tracksPerProject: 20,
  sourcesPerProject: 20,
  urlMaxChars: 2_048,
  artifactKeyMaxChars: 1_024,
  artifactMediaTypeMaxChars: 100,
  /** Per artifact. Individual adapters use tighter limits (e.g. 256 KiB per repository file). */
  artifactTextMaxBytes: 4 * 1024 * 1024,
  artifactsPerSnapshot: 1_000,
  /** Serialized JSON size of snapshot metadata, artifact metadata and failure metadata. */
  metadataMaxBytes: 64 * 1024,
  actorSubjectMaxChars: 255,
  actorIssuerMaxChars: 512,
} as const;

/** A full 40-hex Git commit SHA. GitHub snapshots always pin one. */
export const GIT_COMMIT_SHA_PATTERN = '^[0-9a-f]{40}$';
export const GitCommitSha = z.string().regex(new RegExp(GIT_COMMIT_SHA_PATTERN));

export const SHA256_HEX_PATTERN = '^[0-9a-f]{64}$';
export const Sha256Hex = z.string().regex(new RegExp(SHA256_HEX_PATTERN));

/**
 * The only keys failure metadata may carry. Values are numbers or short machine identifiers, so
 * response bodies, headers, tokens and raw errors cannot be stored (the database checks the keys
 * too).
 */
export const CAPTURE_FAILURE_METADATA_KEYS = [
  'adapter',
  'reason',
  'host',
  'httpStatus',
  'elapsedMs',
  'retryAfterSeconds',
  'limit',
  'limitValue',
  'attempts',
  'redirectCount',
] as const;

const ShortIdentifier = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);
const NonNegativeInt = z.number().int().min(0).max(2_147_483_647);

export const CaptureFailureMetadata = z.strictObject({
  adapter: ShortIdentifier.optional(),
  reason: ShortIdentifier.optional(),
  /** A hostname only: never a path, query, credentials or full URL. */
  host: z
    .string()
    .max(253)
    .regex(/^[a-z0-9.:[\]-]+$/)
    .optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  elapsedMs: NonNegativeInt.optional(),
  retryAfterSeconds: NonNegativeInt.optional(),
  limit: ShortIdentifier.optional(),
  limitValue: NonNegativeInt.optional(),
  attempts: NonNegativeInt.optional(),
  redirectCount: NonNegativeInt.optional(),
});
export type CaptureFailureMetadata = z.infer<typeof CaptureFailureMetadata>;
