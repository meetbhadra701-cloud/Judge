import type {
  EventContextDocument,
  EventSourceType,
  EventSourceAuthority,
} from '@judge-copilot/schemas';
import { canonicalJson, sha256Hex } from './hash.js';

/** The source fields an extraction depends on. Text is represented by its stored content hash. */
export interface FingerprintSource {
  id: string;
  position: number;
  authority: EventSourceAuthority;
  sourceType: EventSourceType;
  title: string;
  url: string | null;
  contentHash: string;
}

/**
 * Deterministic fingerprint of the exact source set given to an extractor. Any added, removed or
 * reordered source (or a changed authority, type, title, URL or content hash) changes it.
 */
export function sourceSetFingerprint(sources: readonly FingerprintSource[]): string {
  const ordered = [...sources]
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ id, position, authority, sourceType, title, url, contentHash }) => ({
      id,
      position,
      authority,
      sourceType,
      title,
      url,
      contentHash,
    }));
  return sha256Hex(canonicalJson(ordered));
}

export interface DraftState {
  /** The reviewed draft document (null until built or authored). */
  document: EventContextDocument | null;
  /** The last successful build output, i.e. the baseline human edits are measured against. */
  extraction: EventContextDocument | null;
}

/** Deterministic fingerprint of a draft's reviewed document and its extraction baseline. */
export function draftStateFingerprint(state: DraftState): string {
  return sha256Hex(canonicalJson({ document: state.document, extraction: state.extraction }));
}

/**
 * Whether replacing the draft document would discard reviewed or manual work: a document exists
 * without any extraction baseline (authored by hand, or copied from a locked version), or the
 * document differs canonically from the last extraction (a human edited it).
 */
export function hasReviewedChanges(state: DraftState): boolean {
  if (state.document === null) {
    return false;
  }
  if (state.extraction === null) {
    return true;
  }
  return canonicalJson(state.document) !== canonicalJson(state.extraction);
}
