import { canonicalJson, sha256Hex } from '@judge-copilot/context';

/*
 * The CANONICAL identities of M5 persistence (R4 F5, F6, F9). Every identity is built here, from values the persistence layer read from
 * the database or derived itself; a caller never supplies a hash and asks to be believed. Each identity is a canonical JSON text, its
 * key is the SHA-256 of that text, and the text is stored beside the key so that both the database triggers (migration 0013) and a
 * later verifier can check the key against the text and the text against the columns it summarizes.
 */

export const REQUEST_IDENTITY_VERSION = 'assessment-request/v1';
export const ASSESSMENT_IDENTITY_VERSION = 'assessment-identity/v1';
export const EXTRACTION_IDENTITY_VERSION = 'extraction-identity/v1';
export const CALL_BINDING_VERSION = 'call-binding/v1';

export interface Identity {
  readonly canonical: string;
  readonly key: string;
}

const identity = (value: unknown): Identity => {
  const canonical = canonicalJson(value);
  return { canonical, key: sha256Hex(canonical) };
};

export type TargetIdentity =
  { readonly kind: 'overall' } | { readonly kind: 'track'; readonly trackKey: string };

const targetParts = (target: TargetIdentity) => ({
  targetKind: target.kind,
  targetTrackKey: target.kind === 'track' ? target.trackKey : null,
});

// -- The request ---------------------------------------------------------------------------------------------------------------

export interface RequestIdentityInput {
  readonly projectId: string;
  readonly mode: 'assess' | 'reassess';
  readonly target: TargetIdentity;
  readonly pipelineConfigHash: string;
  readonly limits: Readonly<Record<string, number>>;
  readonly priceTableId: string;
}

/**
 * What an idempotent request IS. The same actor and key with anything different here (another project, another target, another
 * mode, another configuration or budget) is `key_reused`, never a replay of the earlier run.
 */
export function requestIdentityOf(input: RequestIdentityInput): Identity {
  return identity({
    v: REQUEST_IDENTITY_VERSION,
    projectId: input.projectId,
    mode: input.mode,
    ...targetParts(input.target),
    pipelineConfigHash: input.pipelineConfigHash,
    limits: input.limits,
    priceTableId: input.priceTableId,
  });
}

// -- The intended assessment -------------------------------------------------------------------------------------------------

export interface AssessmentIdentityInput {
  readonly projectId: string;
  readonly eventId: string;
  readonly contextVersionId: string;
  readonly lockedContentHash: string;
  readonly trackSelectionSetHash: string;
  readonly declaredTrackKeys: readonly string[];
  readonly target: TargetIdentity;
  readonly snapshots: readonly { readonly snapshotId: string; readonly contentHash: string }[];
  readonly pipelineConfigHash: string;
  /** "" for `assess`; the request id for `reassess`, so an explicit re-assessment is a new version. */
  readonly salt: string;
}

/** What an assessment is about, frozen when its run is created. `assessment_key` is the key of this identity. */
export function assessmentIdentityOf(input: AssessmentIdentityInput): Identity {
  return identity({
    v: ASSESSMENT_IDENTITY_VERSION,
    projectId: input.projectId,
    eventId: input.eventId,
    contextVersionId: input.contextVersionId,
    lockedContentHash: input.lockedContentHash,
    trackSelectionSetHash: input.trackSelectionSetHash,
    declaredTrackKeys: [...input.declaredTrackKeys],
    ...targetParts(input.target),
    snapshots: [...input.snapshots]
      .map(({ snapshotId, contentHash }) => ({ snapshotId, contentHash }))
      .sort((a, b) => (a.snapshotId < b.snapshotId ? -1 : a.snapshotId > b.snapshotId ? 1 : 0)),
    pipelineConfigHash: input.pipelineConfigHash,
    salt: input.salt,
  });
}

// -- An extraction ---------------------------------------------------------------------------------------------------------------

export interface SourceExtractionIdentityInput {
  readonly kind: 'source';
  readonly projectId: string;
  readonly configHash: string;
  readonly snapshots: readonly { readonly snapshotId: string; readonly contentHash: string }[];
}

export interface ContextExtractionIdentityInput {
  readonly kind: 'context_evidence';
  readonly projectId: string;
  readonly configHash: string;
  readonly contextVersionId: string;
  readonly lockedContentHash: string;
  readonly declaredTrackKeys: readonly string[];
}

/**
 * Every input that defines an extraction: the project, the configuration, and either the snapshots with their stored content hashes
 * or the locked version with its content hash and the declared tracks the reference set was built for. The extraction KEY is derived
 * from this, so the same key cannot stand for other snapshots, another version or another configuration.
 */
export function extractionIdentityOf(
  input: SourceExtractionIdentityInput | ContextExtractionIdentityInput,
): Identity {
  if (input.kind === 'source') {
    return identity({
      v: EXTRACTION_IDENTITY_VERSION,
      kind: 'source',
      projectId: input.projectId,
      configHash: input.configHash,
      snapshots: [...input.snapshots]
        .map(({ snapshotId, contentHash }) => ({ snapshotId, contentHash }))
        .sort((a, b) => (a.snapshotId < b.snapshotId ? -1 : a.snapshotId > b.snapshotId ? 1 : 0)),
      declaredTrackKeys: [],
    });
  }
  return identity({
    v: EXTRACTION_IDENTITY_VERSION,
    kind: 'context_evidence',
    projectId: input.projectId,
    configHash: input.configHash,
    contextVersionId: input.contextVersionId,
    lockedContentHash: input.lockedContentHash,
    declaredTrackKeys: [...input.declaredTrackKeys],
  });
}

/** SHA-256 of the canonical content an extraction was created from (batch and per-record metadata). */
export function contentFingerprintOf(content: unknown): string {
  return sha256Hex(canonicalJson({ v: EXTRACTION_IDENTITY_VERSION, content }));
}

// -- A model call ------------------------------------------------------------------------------------------------------------------

export interface CallBindingInput {
  readonly stage: string;
  readonly requestDigest: string;
  readonly dimensionId: string | null;
  readonly provider: string | null;
  readonly providerMode: string | null;
  readonly model: string;
  readonly promptId: string | null;
  readonly promptVersion: string | null;
  readonly promptTemplateHash: string | null;
  readonly schemaId: string | null;
  readonly schemaVersion: string | null;
  readonly closedSet: unknown;
}

/**
 * The binding of one closed set to the exact request that was sent: stage, request digest, the dimension, and the model, prompt and
 * schema identity. `closed_set_hash` is the SHA-256 of this text, so the handles recorded for one call cannot be attached to another.
 */
export function callBindingOf(input: CallBindingInput): Identity {
  return identity({ v: CALL_BINDING_VERSION, ...input });
}
