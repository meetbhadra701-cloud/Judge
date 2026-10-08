import {
  classifyRepositoryArtifact,
  isEvidenceVerificationAllowed,
  type KnownEntities,
} from '@judge-copilot/evidence';
import type { EvidenceChannel, EvidenceRecord, VerificationLevel } from '@judge-copilot/schemas';
import type { EffectiveLevel } from './parameters.js';

/*
 * Effective evidence trust (docs/milestones/M4-design.md §2.2). FAIL CLOSED.
 *
 * A stored `verification_level` is a LABEL. Rows can be written around the validated write path
 * (direct SQL), and the M3 integrity validator cannot tell such a row from a legitimate one, so M4
 * never reads a label as trust. It re-derives the strongest level the STRUCTURE supports and caps
 * the result at what the label claims:
 *
 *   machine_verified | judge_verified | live_verified  ->  unverified   (unattested; see below)
 *   repo_corroborated -> repo_corroborated only for a GitHub `fact` anchored to an artifact that is
 *                        repository SOURCE CODE (not README/docs/metadata) in a captured or partial
 *                        GitHub snapshot of the same project; otherwise unverified
 *   team_claim        -> team_claim when the origin/kind may carry it; otherwise unverified
 *   anything else     -> unverified
 *
 * Trusted attestations are INTERNAL and EMPTY in M4: no caller, assessor or model can supply one
 * (there is no input for it anywhere), and the parameter table has no weight for the privileged
 * levels. A privileged label therefore never raises effective trust. It is also distrusted for its
 * other structure, because a label the validated write path cannot produce shows the row did not
 * come through that path.
 *
 * `repo_corroborated` is PRODUCER-ASSERTED and limited: the producer chose the evidence text, the
 * claim and the relation, and nothing here proves the text reflects the code. A claim's own label
 * is never consulted at all.
 */

export type TrustFlag =
  | 'unattested_privileged_level'
  | 'unsupported_repo_corroboration'
  | 'unsupported_verification_label';

export interface ResolvedTrust {
  readonly level: EffectiveLevel;
  readonly flag: TrustFlag | null;
}

const PRIVILEGED: readonly VerificationLevel[] = [
  'machine_verified',
  'judge_verified',
  'live_verified',
];

/** True for the levels M4 can never grant: they need an attestation architecture that does not exist yet. */
export function isPrivilegedLevel(level: VerificationLevel): boolean {
  return PRIVILEGED.includes(level);
}

export function resolveEffectiveTrust(
  evidence: EvidenceRecord,
  known: KnownEntities,
): ResolvedTrust {
  const label = evidence.verificationLevel;
  if (isPrivilegedLevel(label)) {
    return { level: 'unverified', flag: 'unattested_privileged_level' };
  }
  switch (label) {
    case 'unverified':
      return { level: 'unverified', flag: null };
    case 'team_claim':
      return isEvidenceVerificationAllowed(evidence.origin, evidence.kind, 'team_claim')
        ? { level: 'team_claim', flag: null }
        : { level: 'unverified', flag: 'unsupported_verification_label' };
    case 'repo_corroborated':
      return isRepoCorroborationStructurallySupported(evidence, known)
        ? { level: 'repo_corroborated', flag: null }
        : { level: 'unverified', flag: 'unsupported_repo_corroboration' };
    default:
      // `contradicted` is never valid on an evidence item.
      return { level: 'unverified', flag: 'unsupported_verification_label' };
  }
}

function isRepoCorroborationStructurallySupported(
  evidence: EvidenceRecord,
  known: KnownEntities,
): boolean {
  if (
    evidence.origin !== 'github' ||
    evidence.kind !== 'fact' ||
    !isEvidenceVerificationAllowed(evidence.origin, evidence.kind, 'repo_corroborated')
  ) {
    return false;
  }
  const { snapshotId, artifactId } = evidence.provenance;
  if (snapshotId === null || artifactId === null) return false;
  const artifact = known.artifacts.get(artifactId);
  const snapshot = known.snapshots.get(snapshotId);
  if (!artifact || !snapshot) return false;
  return (
    artifact.snapshotId === snapshotId &&
    snapshot.projectId === evidence.projectId &&
    snapshot.sourceType === 'github' &&
    (snapshot.status === 'captured' || snapshot.status === 'partial') &&
    classifyRepositoryArtifact({
      key: artifact.key,
      kind: artifact.kind,
      mediaType: artifact.mediaType,
    }) === 'source_code'
  );
}

/** The kind of material an item is, derived from structure (never chosen by an assessor). */
export function channelOf(evidence: EvidenceRecord, known: KnownEntities): EvidenceChannel {
  switch (evidence.origin) {
    case 'github': {
      const artifact =
        evidence.provenance.artifactId === null
          ? undefined
          : known.artifacts.get(evidence.provenance.artifactId);
      return artifact !== undefined &&
        classifyRepositoryArtifact({
          key: artifact.key,
          kind: artifact.kind,
          mediaType: artifact.mediaType,
        }) === 'source_code'
        ? 'source_code'
        : 'repository';
    }
    case 'devpost':
      return 'submission';
    case 'deployment':
      return 'deployment';
    case 'video':
      return 'video';
    case 'event_context':
      return 'event_context';
    case 'team_answer':
      return 'team_answer';
    case 'judge_observation':
      return 'judge_observation';
  }
}

/** Only `fact` and `claim` evidence can support anything. Absence/unknown/contradiction create uncertainty. */
export function isUsableKind(kind: EvidenceRecord['kind']): boolean {
  return kind === 'fact' || kind === 'claim';
}
