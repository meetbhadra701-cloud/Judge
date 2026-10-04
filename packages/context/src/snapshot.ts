import type { EventContextDocument, EventSourceSummary } from '@judge-copilot/schemas';
import { canonicalJson, sha256Hex } from './hash.js';

type HashedSource = Pick<
  EventSourceSummary,
  'id' | 'authority' | 'sourceType' | 'title' | 'url' | 'contentHash'
>;

/**
 * SHA-256 over the canonical JSON of a version's document and its sources' identities and
 * content hashes. Stored when a version locks; recomputing it later proves the frozen version
 * reconstructs exactly.
 */
export function lockedContentHash(input: {
  document: EventContextDocument;
  sources: readonly HashedSource[];
}): string {
  const sources = [...input.sources]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ id, authority, sourceType, title, url, contentHash }) => ({
      id,
      authority,
      sourceType,
      title,
      url,
      contentHash,
    }));
  return sha256Hex(canonicalJson({ document: input.document, sources }));
}
