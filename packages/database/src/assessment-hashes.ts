import { canonicalJson, sha256Hex } from '@judge-copilot/context';

/*
 * The hashes M5 persistence compares between two independent database reads (pin time, read time, commit time). They are COMPARISON
 * values, not authorization: the authority is that PostgreSQL returned the rows to trusted reader code inside one snapshot.
 */

export interface TrackSelectionRef {
  readonly selectionId: string;
  readonly trackKey: string;
}

/** Order-independent hash of a project's declared-track set: the selection rows and the keys they declare. */
export function trackSelectionSetHash(selections: readonly TrackSelectionRef[]): string {
  const sorted = [...selections]
    .map(({ selectionId, trackKey }) => [selectionId, trackKey] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256Hex(canonicalJson(sorted));
}

export interface PinnedInputsFingerprintInput {
  readonly contextVersionId: string;
  readonly lockedContentHash: string;
  readonly trackSelectionSetHash: string;
  readonly target: { readonly kind: 'overall' | 'track'; readonly trackKey: string | null };
  readonly snapshots: readonly { readonly snapshotId: string; readonly contentHash: string }[];
  readonly pipelineConfigHash: string;
}

/** One digest over everything a run is pinned to. The reader recomputes it from rows it read itself and compares. */
export function inputsFingerprint(input: PinnedInputsFingerprintInput): string {
  const snapshots = [...input.snapshots]
    .map(({ snapshotId, contentHash }) => [snapshotId, contentHash] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256Hex(
    canonicalJson({
      contextVersionId: input.contextVersionId,
      lockedContentHash: input.lockedContentHash,
      trackSelectionSetHash: input.trackSelectionSetHash,
      target: input.target,
      snapshots,
      pipelineConfigHash: input.pipelineConfigHash,
    }),
  );
}

/** Nano-USD is the unit of the model port and of every column; a display conversion to micro-USD NEVER rounds usage down. */
export function nanoToMicroUsdCeil(nano: number): number {
  if (!Number.isSafeInteger(nano) || nano < 0)
    throw new RangeError('nano-USD must be a non-negative safe integer');
  return Math.ceil(nano / 1_000);
}

/** The exact inverse for whole micro-USD amounts; refuses values that would not be exactly representable. */
export function microToNanoUsd(micro: number): number {
  if (!Number.isSafeInteger(micro) || micro < 0)
    throw new RangeError('micro-USD must be a non-negative safe integer');
  const nano = micro * 1_000;
  if (!Number.isSafeInteger(nano))
    throw new RangeError('micro-USD amount too large to convert exactly');
  return nano;
}
