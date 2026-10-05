import type { SnapshotArtifactKind } from '@judge-copilot/schemas';
import { canonicalJson, sha256Hex, utf8ByteLength } from './hash.js';
import type { CapturedArtifact, JsonObject, JsonValue } from './ports.js';

export function textArtifact(
  key: string,
  kind: SnapshotArtifactKind,
  mediaType: string,
  textContent: string,
  metadata: JsonObject = {},
): CapturedArtifact {
  return {
    key,
    kind,
    mediaType,
    textContent,
    byteLength: utf8ByteLength(textContent),
    contentHash: sha256Hex(textContent),
    metadata,
  };
}

/** A JSON artifact serialized deterministically (sorted keys, two-space indentation). */
export function jsonArtifact(
  key: string,
  kind: SnapshotArtifactKind,
  value: JsonValue,
  metadata: JsonObject = {},
): CapturedArtifact {
  return textArtifact(key, kind, 'application/json', canonicalJson(value, 2), metadata);
}
