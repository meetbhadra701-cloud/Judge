import type { CapturePartialReason, ProjectSourceType } from '@judge-copilot/schemas';
import { canonicalJson, sha256Hex } from './hash.js';
import type { CapturedArtifact, JsonObject } from './ports.js';

export const SNAPSHOT_CONTENT_HASH_VERSION = 'snapshot-content/v1';

export interface SnapshotContentHashInput {
  readonly sourceType: ProjectSourceType;
  readonly sourceUrl: string;
  readonly revision: string | null;
  readonly metadata: JsonObject;
  readonly partialReasons: readonly CapturePartialReason[];
  readonly artifacts: readonly Pick<
    CapturedArtifact,
    'key' | 'kind' | 'mediaType' | 'byteLength' | 'contentHash' | 'metadata'
  >[];
}

/**
 * Deterministic aggregate hash of captured content: source type and URL, revision, normalized
 * metadata, partial reasons and the sorted artifact keys with their independent hashes. Capture
 * timestamps and database IDs are deliberately excluded, so two captures of identical content
 * share a hash while remaining distinct snapshots.
 */
export function snapshotContentHash(input: SnapshotContentHashInput): string {
  const artifacts = [...input.artifacts]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((artifact) => ({
      key: artifact.key,
      kind: artifact.kind,
      mediaType: artifact.mediaType,
      byteLength: artifact.byteLength,
      contentHash: artifact.contentHash,
      metadata: artifact.metadata,
    }));
  return sha256Hex(
    canonicalJson({
      hashVersion: SNAPSHOT_CONTENT_HASH_VERSION,
      sourceType: input.sourceType,
      sourceUrl: input.sourceUrl,
      revision: input.revision,
      metadata: input.metadata,
      partialReasons: [...new Set(input.partialReasons)].sort(),
      artifacts,
    }),
  );
}
