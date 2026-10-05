import { CAPTURE_REJECTION_CATEGORIES, snapshotStatusForFailure } from '@judge-copilot/domain';
import {
  CaptureFailureCategory,
  CaptureFailureMetadata,
  CapturePartialReason,
  GitCommitSha,
  type ProjectSourceType,
  SnapshotArtifactKind,
  SOURCE_INGESTION_LIMITS,
} from '@judge-copilot/schemas';
import { z } from 'zod';
import { sha256Hex, utf8ByteLength } from './hash.js';
import { emptyCounts, hasReplacements, scrubJson, scrubText } from './sanitize.js';
import type { CaptureFailure, CaptureResult, JsonObject, JsonValue } from './ports.js';

/*
 * Orchestration never trusts adapter output blindly: a result is validated for shape, limits and
 * internal consistency before anything is persisted. An invalid result becomes `internal_error`,
 * never a fabricated snapshot.
 */

const L = SOURCE_INGESTION_LIMITS;

const BoundedJsonObject = z
  .record(z.string(), z.json())
  .refine((value) => utf8ByteLength(JSON.stringify(value)) <= L.metadataMaxBytes, {
    message: `metadata exceeds ${String(L.metadataMaxBytes)} bytes`,
  });

const Artifact = z.strictObject({
  key: z
    .string()
    .min(1)
    .max(L.artifactKeyMaxChars)
    .refine((key) => !key.includes('\u0000'), 'artifact keys may not contain NUL'),
  kind: SnapshotArtifactKind,
  mediaType: z
    .string()
    .max(L.artifactMediaTypeMaxChars)
    .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),
  textContent: z.string().refine((text) => !text.includes('\u0000'), 'text may not contain NUL'),
  byteLength: z.number().int().min(0).max(L.artifactTextMaxBytes),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  metadata: BoundedJsonObject,
});

const ContentResult = z.strictObject({
  status: z.enum(['captured', 'partial']),
  revision: GitCommitSha.nullable(),
  metadata: BoundedJsonObject,
  artifacts: z.array(Artifact).max(L.artifactsPerSnapshot),
  partialReasons: z.array(CapturePartialReason),
});

const FailureResult = z.strictObject({
  status: z.enum(['failed', 'rejected']),
  failure: z.strictObject({ category: CaptureFailureCategory, metadata: CaptureFailureMetadata }),
});

export class InvalidCaptureResultError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid capture result: ${issues.join('; ')}`);
    this.name = 'InvalidCaptureResultError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Makes captured content storable (see `sanitize.ts`): U+0000 and unpaired surrogates in artifact
 * text, artifact keys and every metadata string become U+FFFD. An artifact whose text changed gets
 * its byte length and SHA-256 recomputed (the adapter's values described text that cannot be
 * stored). The number of replacements is recorded in `metadata.contentSanitization`.
 */
function scrubContentResult(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result['artifacts']) || !isRecord(result['metadata'])) {
    return result;
  }
  const counts = emptyCounts();
  try {
    const artifacts = (result['artifacts'] as unknown[]).map((raw) => {
      if (!isRecord(raw)) return raw;
      const next: Record<string, unknown> = { ...raw };
      if (typeof raw['key'] === 'string') next['key'] = scrubText(raw['key'], counts);
      if (isRecord(raw['metadata'])) {
        next['metadata'] = scrubJson(raw['metadata'] as JsonValue, counts);
      }
      if (typeof raw['textContent'] === 'string') {
        const before = counts.nulReplaced + counts.invalidSurrogatesReplaced;
        const text = scrubText(raw['textContent'], counts);
        if (counts.nulReplaced + counts.invalidSurrogatesReplaced !== before) {
          next['textContent'] = text;
          next['byteLength'] = utf8ByteLength(text);
          next['contentHash'] = sha256Hex(text);
        }
      }
      return next;
    });
    const metadata = scrubJson(result['metadata'] as JsonValue, counts) as JsonObject;
    return {
      ...result,
      artifacts,
      metadata: hasReplacements(counts)
        ? { ...metadata, contentSanitization: { ...counts } }
        : metadata,
    };
  } catch (error) {
    if (error instanceof RangeError) {
      throw new InvalidCaptureResultError(['metadata nesting is too deep']);
    }
    throw error;
  }
}

/** Validates an adapter result for the given source type. Throws `InvalidCaptureResultError`. */
export function validateCaptureResult(
  sourceType: ProjectSourceType,
  result: unknown,
): CaptureResult {
  const status = (result as { status?: unknown } | null)?.status;
  const issues: string[] = [];
  const describe = (error: z.ZodError) =>
    error.issues.slice(0, 10).map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  if (status === 'failed' || status === 'rejected') {
    const parsed = FailureResult.safeParse(result);
    if (!parsed.success) throw new InvalidCaptureResultError(describe(parsed.error));
    if (snapshotStatusForFailure(parsed.data.failure.category) !== parsed.data.status) {
      throw new InvalidCaptureResultError([
        `category ${parsed.data.failure.category} does not mean ${parsed.data.status}`,
      ]);
    }
    return parsed.data;
  }
  const parsed = ContentResult.safeParse(scrubContentResult(result));
  if (!parsed.success) throw new InvalidCaptureResultError(describe(parsed.error));
  const value = parsed.data;
  if (value.status === 'partial' && value.partialReasons.length === 0) {
    issues.push('a partial capture needs at least one reason');
  }
  if (value.status === 'captured' && value.partialReasons.length > 0) {
    issues.push('a complete capture cannot carry partial reasons');
  }
  if ((sourceType === 'github') !== (value.revision !== null)) {
    issues.push('exactly GitHub snapshots carry a revision');
  }
  const keys = new Set<string>();
  for (const artifact of value.artifacts) {
    if (keys.has(artifact.key)) issues.push(`duplicate artifact key ${artifact.key}`);
    keys.add(artifact.key);
    if (utf8ByteLength(artifact.textContent) !== artifact.byteLength) {
      issues.push(`byte length mismatch for ${artifact.key}`);
    }
    if (sha256Hex(artifact.textContent) !== artifact.contentHash) {
      issues.push(`content hash mismatch for ${artifact.key}`);
    }
  }
  if (issues.length > 0) throw new InvalidCaptureResultError(issues.slice(0, 10));
  return value;
}

/** A sanitized failure result whose status follows from the category. */
export function failureResult(failure: CaptureFailure): CaptureResult {
  return { status: snapshotStatusForFailure(failure.category), failure };
}

export function failure(
  category: z.infer<typeof CaptureFailureCategory>,
  metadata: CaptureFailureMetadata = {},
): CaptureFailure {
  return { category, metadata: CaptureFailureMetadata.parse(metadata) };
}

export function isRejectionCategory(category: z.infer<typeof CaptureFailureCategory>): boolean {
  return (CAPTURE_REJECTION_CATEGORIES as readonly string[]).includes(category);
}

export type { JsonObject };

export type ContentCaptureResult = Extract<CaptureResult, { readonly artifacts: unknown }>;
export type FailureCaptureResult = Extract<CaptureResult, { readonly failure: unknown }>;

/** Type guard: a result carrying captured content (`captured` or `partial`). */
export function isContentResult(result: CaptureResult): result is ContentCaptureResult {
  return 'artifacts' in result;
}
