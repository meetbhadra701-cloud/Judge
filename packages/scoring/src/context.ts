import {
  nodeKey,
  validateGraphIntegrity,
  type EvidenceGraph,
  type GraphIssueCode,
  type KnownEntities,
} from '@judge-copilot/evidence';
import type {
  EventContextLockedSnapshot,
  ScoringDiagnostic,
  ScoringIssue,
} from '@judge-copilot/schemas';
import { compareText, hashOf } from './canonical.js';
import { deepFreeze } from './freeze.js';
import { resolveEffectiveTrust, isPrivilegedLevel, type TrustFlag } from './trust.js';
import { selectRubric, type ScoringTarget } from './rubric/select.js';
import type { RubricSpec } from './rubric/spec.js';

/*
 * The TRUSTED, in-process scoring context.
 *
 * Everything an assessor or model must not control lives here: the rubric (built from the locked
 * Event Context or the fallback definition), the evidence graph and its source facts, and the
 * project's declared tracks. It is built by `createTrustedScoringContext`, which validates it, and
 * it is registered in a module-private WeakSet: `scoreProject` refuses any object that did not come
 * out of that factory, so a payload with the right shape (for example one deserialized from a model
 * response) is not a context.
 *
 * In M4 the declared tracks are supplied by trusted in-process code; M5 provides the database-backed
 * adapter that reads them from stored project track selections. There is no persistence layer, API
 * or request field for them here.
 */

export interface ScoringGraphInput {
  readonly projectId: string;
  readonly eventId: string;
  readonly graph: EvidenceGraph;
  /** Source facts the stored provenance points at (snapshots, artifacts, context versions). */
  readonly known: KnownEntities;
}

export interface CreateTrustedScoringContextInput extends ScoringGraphInput {
  readonly locked: EventContextLockedSnapshot;
  readonly target: ScoringTarget;
  /** From authoritative stored project track selections. */
  readonly declaredTrackKeys: readonly string[];
}

export interface TrustedScoringContext {
  readonly projectId: string;
  readonly eventId: string;
  readonly graph: EvidenceGraph;
  readonly known: KnownEntities;
  readonly rubric: RubricSpec;
  readonly declaredTrackKeys: readonly string[];
  readonly graphFingerprint: string;
  /** Graph-level observations about stored labels, computed once. */
  readonly graphDiagnostics: readonly ScoringDiagnostic[];
}

export type TrustedScoringContextResult =
  | { readonly ok: true; readonly context: TrustedScoringContext }
  | { readonly ok: false; readonly issues: readonly ScoringIssue[] };

const REGISTERED = new WeakSet<object>();

export function isTrustedScoringContext(value: unknown): value is TrustedScoringContext {
  return typeof value === 'object' && value !== null && REGISTERED.has(value);
}

/** Integrity findings about stored LABELS only; the effective-trust rules already neutralize them. */
const NON_FATAL_INTEGRITY: readonly GraphIssueCode[] = [
  'UNJUSTIFIED_VERIFICATION',
  'ARTIFACT_NOT_CORROBORATING',
  'INVALID_VERIFICATION_TRANSITION',
];

const MAX_LISTED = 200;

export function createTrustedScoringContext(
  input: CreateTrustedScoringContextInput,
): TrustedScoringContextResult {
  const issues: ScoringIssue[] = [];

  if (input.locked.eventId !== input.eventId) {
    issues.push({
      code: 'LOCKED_CONTEXT_MISMATCH',
      path: 'locked.eventId',
      message: 'The locked Event Context belongs to another event',
    });
  }

  // One project only: a record of another project anywhere in the graph fails the whole context.
  const foreign: string[] = [];
  const records = input.graph.ordered;
  for (const [type, list] of [
    ['claim', records.claims],
    ['evidence', records.evidence],
    ['relation', records.relations],
    ['unknown', records.unknowns],
    ['contradiction', records.contradictions],
  ] as const) {
    for (const record of list) {
      if (record.projectId !== input.projectId) foreign.push(`${type}:${record.id}`);
    }
  }
  for (const evidence of records.evidence) {
    if (evidence.eventId !== input.eventId) foreign.push(`evidence:${evidence.id}`);
  }
  if (foreign.length > 0) {
    issues.push({
      code: 'GRAPH_MIXED_PROJECTS',
      path: 'graph',
      message: `The graph contains ${String(foreign.length)} record(s) of another project or event`,
    });
  }

  // Structural integrity must hold; findings about labels alone are diagnostics.
  const integrity = validateGraphIntegrity(input.graph, input.known);
  const fatal = integrity.filter((entry) => !NON_FATAL_INTEGRITY.includes(entry.code));
  for (const entry of fatal.slice(0, 50)) {
    issues.push({
      code: 'GRAPH_INTEGRITY_FAILED',
      path: entry.path,
      message: `${entry.code}: ${entry.message}`,
    });
  }

  const selected = selectRubric({
    locked: input.locked,
    target: input.target,
    declaredTrackKeys: input.declaredTrackKeys,
  });
  if (!selected.ok) issues.push(...selected.issues);

  if (issues.length > 0 || !selected.ok) {
    return { ok: false, issues: sortIssues(issues) };
  }

  const context: TrustedScoringContext = Object.freeze({
    projectId: input.projectId,
    eventId: input.eventId,
    graph: input.graph,
    known: input.known,
    rubric: deepFreeze(selected.rubric),
    declaredTrackKeys: Object.freeze([...selected.declaredTrackKeys]),
    graphFingerprint: graphFingerprintOf(input),
    graphDiagnostics: Object.freeze(
      graphLevelDiagnostics(
        input.graph,
        input.known,
        integrity.filter((entry) => NON_FATAL_INTEGRITY.includes(entry.code)),
      ),
    ),
  });
  REGISTERED.add(context);
  return { ok: true, context };
}

export function sortIssues(issues: readonly ScoringIssue[]): ScoringIssue[] {
  return [...issues].sort((a, b) =>
    a.path === b.path ? compareText(a.code, b.code) : compareText(a.path, b.path),
  );
}

// -- Graph fingerprint -------------------------------------------------------------------------

/**
 * Hash of the graph facts that can influence a report: IDs, kinds, origins, stored labels,
 * provenance coordinates, relations, supersession, contradiction and unknown references, and the
 * source facts used to classify artifacts. It excludes free text, timestamps, actors and `seq`
 * (insertion order), none of which the engine reads, so two loads of the same content hash equally.
 */
function graphFingerprintOf(input: ScoringGraphInput): string {
  const { graph, known } = input;
  const byId = <T extends { id: string }>(list: readonly T[]) =>
    [...list].sort((a, b) => compareText(a.id, b.id));

  const referencedArtifacts = new Set<string>();
  const referencedSnapshots = new Set<string>();
  const referencedVersions = new Set<string>();
  for (const evidence of graph.ordered.evidence) {
    if (evidence.provenance.artifactId) referencedArtifacts.add(evidence.provenance.artifactId);
    if (evidence.provenance.snapshotId) referencedSnapshots.add(evidence.provenance.snapshotId);
    if (evidence.provenance.contextVersionId) {
      referencedVersions.add(evidence.provenance.contextVersionId);
    }
  }

  return hashOf({
    projectId: input.projectId,
    eventId: input.eventId,
    claims: byId(graph.ordered.claims).map((claim) => ({
      id: claim.id,
      supersedesId: claim.supersedesId,
      label: claim.verificationLevel,
    })),
    evidence: byId(graph.ordered.evidence).map((item) => ({
      id: item.id,
      kind: item.kind,
      origin: item.origin,
      label: item.verificationLevel,
      snapshotId: item.provenance.snapshotId,
      artifactId: item.provenance.artifactId,
      span: item.provenance.span ? [item.provenance.span.start, item.provenance.span.end] : null,
      contextVersionId: item.provenance.contextVersionId,
    })),
    relations: byId(graph.ordered.relations).map((relation) => ({
      id: relation.id,
      claimId: relation.claimId,
      evidenceId: relation.evidenceId,
      type: relation.type,
    })),
    unknowns: byId(graph.ordered.unknowns).map((unknown) => ({
      id: unknown.id,
      unknownType: unknown.unknownType,
      claimIds: [...unknown.claimIds].sort(compareText),
      evidenceIds: [...unknown.evidenceIds].sort(compareText),
    })),
    contradictions: byId(graph.ordered.contradictions).map((contradiction) => ({
      id: contradiction.id,
      sides: [nodeKey(contradiction.sideA), nodeKey(contradiction.sideB)],
    })),
    artifacts: [...referencedArtifacts].sort(compareText).map((id) => {
      const artifact = known.artifacts.get(id);
      return artifact
        ? {
            id,
            snapshotId: artifact.snapshotId,
            key: artifact.key,
            kind: artifact.kind,
            mediaType: artifact.mediaType,
            contentHash: artifact.contentHash,
          }
        : { id, missing: true };
    }),
    snapshots: [...referencedSnapshots].sort(compareText).map((id) => {
      const snapshot = known.snapshots.get(id);
      return snapshot
        ? {
            id,
            projectId: snapshot.projectId,
            sourceType: snapshot.sourceType,
            status: snapshot.status,
            revision: snapshot.revision,
            contentHash: snapshot.contentHash,
          }
        : { id, missing: true };
    }),
    contextVersions: [...referencedVersions].sort(compareText).map((id) => {
      const version = known.contextVersions.get(id);
      return version
        ? { id, eventId: version.eventId, version: version.version, status: version.status }
        : { id, missing: true };
    }),
  });
}

// -- Graph-level label diagnostics -------------------------------------------------------------

const FLAG_CODE: Record<TrustFlag, ScoringDiagnostic['code']> = {
  unattested_privileged_level: 'UNATTESTED_PRIVILEGED_LEVEL',
  unsupported_repo_corroboration: 'UNSUPPORTED_REPO_CORROBORATION',
  unsupported_verification_label: 'UNSUPPORTED_VERIFICATION_LABEL',
};

const FLAG_MESSAGE: Record<TrustFlag, string> = {
  unattested_privileged_level:
    'Stored with a verification label that M4 cannot attest (machine_verified, judge_verified or live_verified); treated as unverified',
  unsupported_repo_corroboration:
    'Stored as repo_corroborated, but the structure does not support it (not a GitHub fact anchored to repository source code); treated as unverified',
  unsupported_verification_label:
    'Stored with a verification label its origin and kind cannot carry; treated as unverified',
};

function graphLevelDiagnostics(
  graph: EvidenceGraph,
  known: KnownEntities,
  labelIssues: readonly { code: GraphIssueCode; path: string }[],
): ScoringDiagnostic[] {
  const byFlag = new Map<TrustFlag, string[]>();
  for (const evidence of graph.ordered.evidence) {
    const { flag } = resolveEffectiveTrust(evidence, known);
    if (flag === null) continue;
    const list = byFlag.get(flag);
    if (list) list.push(evidence.id);
    else byFlag.set(flag, [evidence.id]);
  }
  const diagnostics: ScoringDiagnostic[] = [];
  for (const flag of [
    'unattested_privileged_level',
    'unsupported_repo_corroboration',
    'unsupported_verification_label',
  ] as const) {
    const ids = byFlag.get(flag);
    if (ids) diagnostics.push(listed(FLAG_CODE[flag], 'graph.evidence', ids, FLAG_MESSAGE[flag]));
  }

  const privilegedClaims = graph.ordered.claims
    .filter((claim) => isPrivilegedLevel(claim.verificationLevel))
    .map((claim) => claim.id);
  if (privilegedClaims.length > 0) {
    diagnostics.push(
      listed(
        'UNATTESTED_PRIVILEGED_LEVEL',
        'graph.claims',
        privilegedClaims,
        'Claim stored with a privileged verification label; claim labels are never used by any formula and never prove truth',
      ),
    );
  }

  if (labelIssues.length > 0) {
    diagnostics.push(
      listed(
        'GRAPH_LABEL_NOT_JUSTIFIED',
        'graph',
        labelIssues.map((entry) => `${entry.code}@${entry.path}`),
        'Stored verification labels that the graph does not justify (reported by the M3 integrity validator); no label is used as trust',
      ),
    );
  }
  return diagnostics;
}

function listed(
  code: ScoringDiagnostic['code'],
  path: string,
  ids: readonly string[],
  message: string,
): ScoringDiagnostic {
  const sorted = [...ids].sort(compareText);
  return {
    code,
    path,
    entityIds: sorted.slice(0, MAX_LISTED),
    message:
      sorted.length > MAX_LISTED
        ? `${message} (${String(sorted.length)} records; the first ${String(MAX_LISTED)} are listed)`
        : message,
  };
}
