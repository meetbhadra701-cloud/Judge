import type { EvidenceKind, EvidenceOrigin, VerificationLevel } from '@judge-copilot/schemas';

/*
 * Verification-level rules (docs/SCORING.md §8, invariants 3 and 4). Everything here is
 * deterministic and table-driven so the database CHECK constraints and triggers can be generated
 * from, and tested against, the same tables.
 *
 * The central rule: A TEAM STATEMENT IS NOT A VERIFIED FACT. Successfully capturing a Devpost
 * sentence proves the sentence existed, not that it is true, so project-authored prose can never
 * exceed `team_claim` by origin alone. Raw counts (commits, keywords) never raise a level.
 *
 * Verification levels apply at two places:
 *   - an EvidenceItem carries the level of the observation itself. It is fixed at creation
 *     (evidence is immutable); `evidenceLevelsFor` lists what each (origin, kind) may carry.
 *   - a Claim carries the level it has reached. A claim never changes; a new claim version
 *     supersedes it, and `isVerificationTransitionAllowed` validates old level -> new level.
 *     `claimLevelJustification` says what graph material a level needs.
 */

/**
 * The evidence ladder of docs/SCORING.md §8: `unverified` < `team_claim` <
 * `repo_corroborated` = `machine_verified` < `judge_verified` = `live_verified`.
 * `contradicted` is deliberately NOT on the ladder: it is a separate state that accompanies a
 * Contradiction record and an uncertainty, never an automatic penalty.
 */
export const VERIFICATION_TIER: Readonly<
  Record<Exclude<VerificationLevel, 'contradicted'>, number>
> = {
  unverified: 0,
  team_claim: 1,
  repo_corroborated: 2,
  machine_verified: 2,
  judge_verified: 3,
  live_verified: 3,
};

export function verificationTier(level: VerificationLevel): number | null {
  return level === 'contradicted' ? null : VERIFICATION_TIER[level];
}

/**
 * Claim level transitions (a new claim superseding an old one):
 *   - to or from `contradicted` is always allowed (a contradiction can appear, and a judge can
 *     later resolve it), subject to the justification rules below;
 *   - otherwise the new level's tier must not be lower than the old level's tier. A claim never
 *     silently loses verification; an equal tier (including `repo_corroborated` <->
 *     `machine_verified` and `judge_verified` <-> `live_verified`) and staying put are allowed.
 * A transition allows a level; it never grants one: the new claim still needs its own
 * justification from graph material.
 */
export function isVerificationTransitionAllowed(
  from: VerificationLevel,
  to: VerificationLevel,
): boolean {
  const fromTier = verificationTier(from);
  const toTier = verificationTier(to);
  if (fromTier === null || toTier === null) return true;
  return toTier >= fromTier;
}

// -- Evidence: which levels may each (origin, kind) carry --------------------------------------

/** Origins whose evidence can be created in M3. The other two need M7 records to point at. */
export const M3_EVIDENCE_ORIGINS = [
  'event_context',
  'devpost',
  'github',
  'deployment',
  'video',
] as const satisfies readonly EvidenceOrigin[];

/** Origins that M3 recognizes as vocabulary only: M7 (interview) supplies their provenance records. */
export const DEFERRED_EVIDENCE_ORIGINS = [
  'team_answer',
  'judge_observation',
] as const satisfies readonly EvidenceOrigin[];

export function isOriginCreatableInM3(origin: EvidenceOrigin): boolean {
  return (M3_EVIDENCE_ORIGINS as readonly EvidenceOrigin[]).includes(origin);
}

/**
 * Verification levels a PRODUCER-created graph batch can carry in M3 (evidence items and claims).
 *
 * The level vocabulary is unchanged and the rules for every level stay defined below, because
 * later milestones need them. But a level only means something if trusted code established it:
 *
 *  - `machine_verified` means a fact established by TRUSTED DETERMINISTIC MACHINE OBSERVATION. A
 *    span proves provenance: that the cited text exists in an immutable snapshot. It does NOT prove
 *    that the evidence item's semantic `text`, or any claim, is true; M3 has no deterministic
 *    verifier of that equivalence. A producer (a fixture today, a model in M5) must therefore not
 *    be able to grant it simply by choosing the enum value. M3 has no trusted observation
 *    producer, so the level is unreachable here. A later milestone adds a separate trusted path.
 *  - `judge_verified` / `live_verified` need judge-observation records that M7 introduces.
 *
 * `repo_corroborated` stays reachable, but only through source-code artifacts (see artifacts.ts),
 * never team-authored prose. It is PRODUCER-ASSERTED and limited: trusted code checks the cited
 * artifact (right project, immutable GitHub snapshot, classified as source code) and that a
 * `supports` relation exists for a corroborated claim, but the producer chooses the evidence text,
 * the claim text and the relationship. M3 does not prove they reflect the code, so a valid code-file
 * reference can support an unrelated claim. It is NOT machine-verified semantic truth.
 * `contradicted` stays reachable for claims, with its Contradiction.
 */
export const M3_PRODUCER_VERIFICATION_LEVELS = [
  'unverified',
  'team_claim',
  'repo_corroborated',
  'contradicted',
] as const satisfies readonly VerificationLevel[];

export function isVerificationLevelAvailableToProducers(level: VerificationLevel): boolean {
  return (M3_PRODUCER_VERIFICATION_LEVELS as readonly VerificationLevel[]).includes(level);
}

type LevelTable = Readonly<Record<EvidenceKind, readonly VerificationLevel[]>>;

const NOTHING_ESTABLISHED: readonly VerificationLevel[] = ['unverified'];
const TEAM_AUTHORED: readonly VerificationLevel[] = ['unverified', 'team_claim'];
const NEVER: readonly VerificationLevel[] = [];

/**
 * Allowed evidence levels per origin and kind. An empty list means "this combination does not
 * exist". The `contradicted` level is never valid on an evidence item.
 *
 *  - Prose written by the team (Devpost, video, and README-like text on GitHub or a deployment)
 *    is a `claim` and tops out at `team_claim`. A Devpost `fact` is still a team statement.
 *  - `repo_corroborated` and `machine_verified` need repository or deployment observation, and
 *    are only valid with an artifact anchor (see `evidenceProvenanceRequirement`).
 *  - `absence` and `unknown` establish nothing: they stay `unverified` (invariant 3).
 *  - Official event context is data of the locked frame, not a project claim.
 *  - `judge_observation` / `team_answer` are M7 vocabulary; their rows are defined here so the
 *    matrix is complete, but M3 refuses to create them.
 */
export const EVIDENCE_LEVEL_RULES: Readonly<Record<EvidenceOrigin, LevelTable>> = {
  event_context: {
    fact: NOTHING_ESTABLISHED,
    claim: NEVER,
    absence: NOTHING_ESTABLISHED,
    unknown: NOTHING_ESTABLISHED,
    contradiction: NOTHING_ESTABLISHED,
  },
  devpost: {
    fact: TEAM_AUTHORED,
    claim: TEAM_AUTHORED,
    absence: NOTHING_ESTABLISHED,
    unknown: NOTHING_ESTABLISHED,
    contradiction: NOTHING_ESTABLISHED,
  },
  video: {
    fact: TEAM_AUTHORED,
    claim: TEAM_AUTHORED,
    absence: NOTHING_ESTABLISHED,
    unknown: NOTHING_ESTABLISHED,
    contradiction: NOTHING_ESTABLISHED,
  },
  github: {
    fact: ['unverified', 'repo_corroborated', 'machine_verified'],
    claim: TEAM_AUTHORED,
    absence: NOTHING_ESTABLISHED,
    unknown: NOTHING_ESTABLISHED,
    contradiction: NOTHING_ESTABLISHED,
  },
  deployment: {
    fact: ['unverified', 'machine_verified'],
    claim: TEAM_AUTHORED,
    absence: NOTHING_ESTABLISHED,
    unknown: NOTHING_ESTABLISHED,
    contradiction: NOTHING_ESTABLISHED,
  },
  team_answer: {
    fact: NEVER,
    claim: TEAM_AUTHORED,
    absence: NEVER,
    unknown: NOTHING_ESTABLISHED,
    contradiction: NOTHING_ESTABLISHED,
  },
  judge_observation: {
    fact: ['judge_verified', 'live_verified'],
    claim: NEVER,
    absence: ['judge_verified', 'live_verified'],
    unknown: NOTHING_ESTABLISHED,
    contradiction: ['unverified', 'judge_verified'],
  },
};

export function evidenceLevelsFor(
  origin: EvidenceOrigin,
  kind: EvidenceKind,
): readonly VerificationLevel[] {
  return EVIDENCE_LEVEL_RULES[origin][kind];
}

export function isEvidenceVerificationAllowed(
  origin: EvidenceOrigin,
  kind: EvidenceKind,
  level: VerificationLevel,
): boolean {
  return evidenceLevelsFor(origin, kind).includes(level);
}

/** Every allowed (origin, kind, level) triple, in vocabulary order. Used to generate CHECKs. */
export function allowedEvidenceCombinations(
  origins: readonly EvidenceOrigin[],
  kinds: readonly EvidenceKind[],
): { origin: EvidenceOrigin; kind: EvidenceKind; levels: readonly VerificationLevel[] }[] {
  return origins.flatMap((origin) =>
    kinds
      .map((kind) => ({ origin, kind, levels: evidenceLevelsFor(origin, kind) }))
      .filter((entry) => entry.levels.length > 0),
  );
}

// -- Evidence: what a level needs structurally -------------------------------------------------

/**
 * Levels that must be anchored to an artifact of a snapshot, and whether to a span. A level
 * stronger than `unverified` has to point at something a machine can re-read:
 *   - `repo_corroborated`: an artifact of the GitHub snapshot (which must be source code, see
 *     artifacts.ts);
 *   - `machine_verified`: an artifact AND a span. The span makes the QUOTATION machine-checkable;
 *     it does not make the evidence text or a claim true. The level itself is not reachable by
 *     producers in M3 (see `M3_PRODUCER_VERIFICATION_LEVELS`).
 */
export function evidenceAnchorRequirement(level: VerificationLevel): {
  artifact: boolean;
  span: boolean;
} {
  switch (level) {
    case 'machine_verified':
      return { artifact: true, span: true };
    case 'repo_corroborated':
      return { artifact: true, span: false };
    default:
      return { artifact: false, span: false };
  }
}

// -- Claims: what graph material a level needs ------------------------------------------------

/** The slice of an evidence item the claim-justification rules look at. */
export interface JustifyingEvidence {
  origin: EvidenceOrigin;
  kind: EvidenceKind;
  verificationLevel: VerificationLevel;
}

export type ClaimJustification =
  | { kind: 'none' }
  | {
      kind: 'supporting_evidence';
      describe: string;
      accepts: (evidence: JustifyingEvidence) => boolean;
    }
  | { kind: 'contradiction_record' };

/**
 * What a claim must be connected to in the graph to carry a level. Creating a relation never
 * changes a claim's level (invariant: no silent mutation); instead a claim DECLARED at a level is
 * checked against its own `supports` relations / Contradiction records.
 *
 *  - `unverified`, `team_claim`: nothing (a team statement needs no corroboration to exist).
 *  - `repo_corroborated`: a `supports` GitHub `fact` at `repo_corroborated`/`machine_verified`.
 *    This checks the graph SHAPE and the artifact class only; the producer still chooses what the
 *    evidence and the claim say (see `M3_PRODUCER_VERIFICATION_LEVELS`).
 *  - `machine_verified`: a `supports` GitHub/deployment `fact` at `machine_verified`.
 *  - `judge_verified`: a `supports` `judge_observation` `fact` at `judge_verified`/`live_verified`
 *    (unreachable until M7 can create such evidence).
 *  - `live_verified`: a `supports` `judge_observation` `fact` at `live_verified` (likewise M7).
 *  - `contradicted`: a Contradiction record with this claim as a side (docs/SCORING.md §8).
 */
export function claimLevelJustification(level: VerificationLevel): ClaimJustification {
  switch (level) {
    case 'unverified':
    case 'team_claim':
      return { kind: 'none' };
    case 'repo_corroborated':
      return {
        kind: 'supporting_evidence',
        describe: 'a supporting GitHub fact at repo_corroborated or machine_verified',
        accepts: (e) =>
          e.origin === 'github' &&
          e.kind === 'fact' &&
          (e.verificationLevel === 'repo_corroborated' ||
            e.verificationLevel === 'machine_verified'),
      };
    case 'machine_verified':
      return {
        kind: 'supporting_evidence',
        describe: 'a supporting GitHub or deployment fact at machine_verified',
        accepts: (e) =>
          (e.origin === 'github' || e.origin === 'deployment') &&
          e.kind === 'fact' &&
          e.verificationLevel === 'machine_verified',
      };
    case 'judge_verified':
      return {
        kind: 'supporting_evidence',
        describe: 'a supporting judge observation at judge_verified or live_verified',
        accepts: (e) =>
          e.origin === 'judge_observation' &&
          e.kind === 'fact' &&
          (e.verificationLevel === 'judge_verified' || e.verificationLevel === 'live_verified'),
      };
    case 'live_verified':
      return {
        kind: 'supporting_evidence',
        describe: 'a supporting judge observation at live_verified',
        accepts: (e) =>
          e.origin === 'judge_observation' &&
          e.kind === 'fact' &&
          e.verificationLevel === 'live_verified',
      };
    case 'contradicted':
      return { kind: 'contradiction_record' };
  }
}

// -- Relations and contradictions: which evidence kinds may take part --------------------------

/**
 * `absence` and `unknown` evidence establish nothing, so they can neither support a claim nor
 * contradict one, and they cannot be a side of a Contradiction: "we did not find it" is not
 * negative evidence (invariant 3). They feed Unknown records instead.
 */
export const RELATION_ELIGIBLE_KINDS = {
  supports: ['fact', 'claim'],
  contradicts: ['fact', 'claim', 'contradiction'],
} as const satisfies Record<string, readonly EvidenceKind[]>;

export function canEvidenceKindTakePart(
  relationType: 'supports' | 'contradicts',
  kind: EvidenceKind,
): boolean {
  return (RELATION_ELIGIBLE_KINDS[relationType] as readonly EvidenceKind[]).includes(kind);
}

/** Evidence kinds that may be one side of a Contradiction. */
export const CONTRADICTION_ELIGIBLE_EVIDENCE_KINDS = [
  'fact',
  'claim',
  'contradiction',
] as const satisfies readonly EvidenceKind[];

export function canEvidenceKindBeContradictionSide(kind: EvidenceKind): boolean {
  return (CONTRADICTION_ELIGIBLE_EVIDENCE_KINDS as readonly EvidenceKind[]).includes(kind);
}
