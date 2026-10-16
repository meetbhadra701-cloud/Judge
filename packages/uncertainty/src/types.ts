import type {
  EvidenceKind,
  EvidenceOrigin,
  ExpectedInformation,
  UncertaintyKind,
  UncertaintySeverity,
  UnknownType,
  VerificationLevel,
} from '@judge-copilot/schemas';

/*
 * The frozen input of the uncertainty analysis and its output. Everything here is plain, already-verified data built by trusted code (the database
 * adapter reads it from a VERIFIED pre-interview assessment and the immutable records it was scored from). The analysis never reads a clock, a
 * database, the network or an environment variable, and never calls a model: the same input always yields byte-identical output.
 *
 * Every `id` is a real stored identifier (a dimension id from the verified report, a claim / evidence / unknown / contradiction UUID of the
 * assessment's pinned extraction). Text fields are bounded, untrusted-or-derived display data: the analysis never interprets them, only copies a
 * bounded excerpt into a neutral observation.
 */

export type DispositionAttributionValue =
  | 'scored'
  | 'insufficient_by_assessor'
  | 'insufficient_by_code'
  | 'insufficient_by_critic'
  | 'technical';

export interface DimensionFact {
  /** The dimension id of the verified report, for example `official.originality`. */
  readonly id: string;
  readonly criterionKey: string;
  readonly name: string;
  /** The official weight of the dimension's criterion in the overall rubric; null when the rubric publishes no weights. */
  readonly criterionWeight: number | null;
  /** Weight of this dimension within its criterion (1 for an official criterion). */
  readonly dimensionWeight: number;
  readonly state: 'assessed' | 'insufficient_evidence';
  readonly insufficiencyReason: 'assessor_reported_insufficient' | 'no_usable_citation' | null;
  readonly attribution: DispositionAttributionValue;
  /** The assessment-confidence INDEX of the verified report (0..1). Not a probability. */
  readonly confidence: number;
  readonly evidenceStrength: number | null;
  readonly citedEvidenceIds: readonly string[];
  readonly contradictionIds: readonly string[];
}

export interface EvidenceFact {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly origin: EvidenceOrigin;
  readonly verificationLevel: VerificationLevel;
  /** Bounded excerpt, for display only. */
  readonly text: string;
}

export interface ClaimFact {
  readonly id: string;
  readonly text: string;
  readonly verificationLevel: VerificationLevel;
  readonly supportingEvidenceIds: readonly string[];
  readonly contradictingEvidenceIds: readonly string[];
}

export interface UnknownFact {
  readonly id: string;
  readonly unknownType: UnknownType;
  readonly text: string;
  readonly claimIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface ContradictionFact {
  readonly id: string;
  readonly description: string;
  readonly sides: readonly { readonly type: 'claim' | 'evidence'; readonly id: string }[];
}

export interface RequirementFact {
  /** The stored evidence id of the Event Context reference item when the extraction holds one, otherwise the builder's stable reference. */
  readonly id: string;
  readonly kind: 'overall_rule' | 'submission_requirement';
  /** The declared track this requirement belongs to, or null for an event-wide statement. */
  readonly trackKey: string | null;
  readonly text: string;
}

export interface CoverageFact {
  /** `not_recorded`: an assessment from before coverage records (coverage UNKNOWN, never "complete"). */
  readonly status: 'recorded' | 'not_recorded';
  readonly verified: boolean;
  readonly verdict: 'complete' | 'partial' | 'insufficient' | null;
  readonly concerns: readonly string[];
  readonly missingSources: readonly ('github' | 'devpost')[];
  readonly partialCapture: boolean;
  readonly implementation: {
    readonly files: number;
    readonly filesShown: number;
    readonly filesUnseen: number;
    readonly inspectedShare: number;
    readonly componentsTotal: number;
    readonly componentsWithShownFile: number;
  } | null;
  /** Components not fully inspected, largest first (bounded). */
  readonly omittedComponents: readonly string[];
}

export interface UncertaintyInput {
  readonly assessment: {
    readonly id: string;
    readonly projectId: string;
    readonly versionNumber: number;
    /** The verified report's own hash: what the questions are tied to. */
    readonly reportOutputHash: string;
    readonly contextVersionId: string;
    readonly contextContentHash: string;
    readonly extractionId: string;
    readonly providerMode: 'live' | 'replay' | 'scripted';
  };
  readonly rubric: {
    readonly name: string;
    readonly weightBasis: 'official' | 'unweighted_official' | 'fallback';
  };
  readonly dimensions: readonly DimensionFact[];
  readonly evidence: readonly EvidenceFact[];
  readonly claims: readonly ClaimFact[];
  readonly unknowns: readonly UnknownFact[];
  readonly contradictions: readonly ContradictionFact[];
  readonly coverage: CoverageFact;
  readonly tracks: {
    readonly declared: readonly { readonly key: string; readonly name: string }[];
    readonly unassessedTrackRubrics: readonly {
      readonly trackKey: string;
      readonly trackName: string;
      readonly rubricName: string;
    }[];
  };
  readonly requirements: readonly RequirementFact[];
}

// -- Output --------------------------------------------------------------------------------------------------------------------

export const TRAIL_TYPES = [
  'dimension',
  'claim',
  'evidence',
  'unknown',
  'contradiction',
  'requirement',
  'coverage',
  'track',
] as const;
export type TrailType = (typeof TRAIL_TYPES)[number];

/** One link of an opportunity's reproducible evidence trail: a stored id that is part of the input, and its role. */
export interface TrailEntry {
  readonly type: TrailType;
  readonly id: string;
  readonly role: 'subject' | 'support' | 'conflict' | 'context';
}

export interface UncertaintyOpportunity {
  /** Code-assigned and reproducible: `opp-` + 16 hex of a hash of the kind and the sorted subject ids. */
  readonly id: string;
  /** 1-based position in the engine's own deterministic order. */
  readonly ordinal: number;
  readonly kind: UncertaintyKind;
  readonly severity: UncertaintySeverity;
  /** Dimension ids (of the verified report) this uncertainty bears on; empty when it is not about a scored dimension. */
  readonly dimensionIds: readonly string[];
  /** Share of the OVERALL rubric the linked dimensions carry, in thousandths, capped at 1000. Decision relevance, never a score. */
  readonly relevanceMilli: number;
  /** The neutral account of what is unknown or contradictory. Never an accusation, never a conclusion about the project. */
  readonly observation: string;
  /** What kinds of answer or demonstration could settle it. */
  readonly clarifiedBy: readonly ExpectedInformation[];
  readonly trail: readonly TrailEntry[];
}

export interface UncertaintyReport {
  readonly engineVersion: 'uncertainty-engine/v1';
  /** `official`, or `equal_for_ranking_only` when the rubric is unweighted (the equal share is used ONLY to order opportunities, never as a weight of the rubric). */
  readonly weightBasis: 'official' | 'equal_for_ranking_only';
  readonly dimensions: readonly {
    readonly id: string;
    readonly name: string;
    readonly weightShareMilli: number;
  }[];
  readonly opportunities: readonly UncertaintyOpportunity[];
  /** What the analysis deliberately did NOT turn into an opportunity, so that silence is explainable. */
  readonly suppressed: {
    readonly unlinkedClaims: number;
    readonly corroboratedClaims: number;
  };
}

export class UncertaintyInputError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`The uncertainty input is inconsistent: ${issues.slice(0, 5).join('; ')}`);
    this.name = 'UncertaintyInputError';
    this.issues = issues;
  }
}
