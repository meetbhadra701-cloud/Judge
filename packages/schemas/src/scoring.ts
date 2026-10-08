import { z } from 'zod';
import { VerificationLevel } from './enums.js';
import { DottedIdentifier, Identifier, Ratio, Score10, Uuid } from './primitives.js';

/*
 * Vocabularies, inputs and report schemas of the deterministic scoring engine (`scoring-engine/v1`,
 * docs/SCORING.md §12 and docs/milestones/M4-design.md).
 *
 * Trust boundary. The ONLY untrusted input the engine accepts is `AssessorJudgmentsInput`: dimension
 * judgments (a score or "insufficient evidence", plus citations classified from closed vocabularies).
 * It is a strict object, so a payload that tries to smuggle attestations, verification overrides,
 * weights or a rubric is rejected, not ignored. Everything else (the rubric, the evidence graph, the
 * project's declared tracks) is TRUSTED in-process context built by trusted code (packages/scoring).
 *
 * Every numeric parameter behind these shapes is a transparent V1 heuristic, not a calibrated
 * statistical probability (invariant 13). `confidence` is an index in [0, 1], never a probability.
 */

export const SCORING_ENGINE_VERSION = 'scoring-engine/v1' as const;
export const FALLBACK_RUBRIC_VERSION = 'fallback-rubric/v1' as const;

/** Fixed text of the unofficial equal-weight preview. It is part of the schema, so it cannot be edited out. */
export const UNOFFICIAL_PREVIEW_NOTICE =
  'UNOFFICIAL PREVIEW: the organizers published no weights for this rubric; equal weights are an assumption of this tool, not an official score.' as const;

export const SCORING_LIMITS = {
  judgmentsMax: 500,
  citationsPerJudgmentMax: 100,
} as const;

// -- Vocabularies ------------------------------------------------------------------------------

/** How directly a cited item shows the thing a dimension is about (assessor-classified, closed set). */
export const EVIDENCE_DIRECTNESS_VALUES = ['direct', 'adjacent', 'indirect'] as const;
export const EvidenceDirectness = z.enum(EVIDENCE_DIRECTNESS_VALUES);
export type EvidenceDirectness = z.infer<typeof EvidenceDirectness>;

/** How exactly a cited item addresses this dimension and claim (assessor-classified, closed set). */
export const EVIDENCE_SPECIFICITY_VALUES = ['exact', 'partial', 'generic'] as const;
export const EvidenceSpecificity = z.enum(EVIDENCE_SPECIFICITY_VALUES);
export type EvidenceSpecificity = z.infer<typeof EvidenceSpecificity>;

/**
 * The kind of material an evidence item is, derived from its origin and artifact class by code
 * (never chosen by an assessor). Used only to measure coverage against declared evidence needs.
 */
export const EVIDENCE_CHANNEL_VALUES = [
  'source_code',
  'repository',
  'submission',
  'deployment',
  'video',
  'event_context',
  'team_answer',
  'judge_observation',
] as const;
export const EvidenceChannel = z.enum(EVIDENCE_CHANNEL_VALUES);
export type EvidenceChannel = z.infer<typeof EvidenceChannel>;

export const RUBRIC_SOURCE_VALUES = ['official_event_context', 'universal_fallback'] as const;
export const RubricSource = z.enum(RUBRIC_SOURCE_VALUES);
export type RubricSource = z.infer<typeof RubricSource>;

/** Where the weights of the rubric come from. `unweighted_official` means there are none. */
export const RUBRIC_WEIGHT_BASIS_VALUES = ['official', 'fallback', 'unweighted_official'] as const;
export const RubricWeightBasis = z.enum(RUBRIC_WEIGHT_BASIS_VALUES);
export type RubricWeightBasis = z.infer<typeof RubricWeightBasis>;

/** `declared`: the rubric states what evidence each dimension needs. `unspecified`: it does not. */
export const NEEDS_BASIS_VALUES = ['declared', 'unspecified'] as const;
export const NeedsBasis = z.enum(NEEDS_BASIS_VALUES);
export type NeedsBasis = z.infer<typeof NeedsBasis>;

export const SCORING_TARGET_KIND_VALUES = ['overall', 'track'] as const;

export const DIMENSION_STATE_VALUES = ['assessed', 'insufficient_evidence'] as const;
export const DimensionState = z.enum(DIMENSION_STATE_VALUES);
export type DimensionState = z.infer<typeof DimensionState>;

export const CRITERION_STATE_VALUES = [
  'assessed',
  'partial',
  'insufficient_evidence',
  'not_applicable',
] as const;
export const CriterionState = z.enum(CRITERION_STATE_VALUES);
export type CriterionState = z.infer<typeof CriterionState>;

export const OVERALL_STATE_VALUES = [
  'scored',
  'scored_partial',
  'insufficient_evidence',
  'not_computed',
] as const;
export const OverallState = z.enum(OVERALL_STATE_VALUES);
export type OverallState = z.infer<typeof OverallState>;

export const INSUFFICIENT_REASON_VALUES = [
  'assessor_reported_insufficient',
  'no_usable_citation',
] as const;
export const InsufficientReason = z.enum(INSUFFICIENT_REASON_VALUES);
export type InsufficientReason = z.infer<typeof InsufficientReason>;

/**
 * What the confidence index multiplies by: real coverage of declared evidence needs, or the weaker
 * citation-presence flag where a rubric declares no needs. The two are NOT comparable.
 */
export const CONFIDENCE_BASIS_VALUES = ['declared_needs_coverage', 'citation_presence'] as const;
export const ConfidenceBasis = z.enum(CONFIDENCE_BASIS_VALUES);
export type ConfidenceBasis = z.infer<typeof ConfidenceBasis>;

/** Fatal: nothing is scored. Issues are collected and returned in a deterministic order. */
export const SCORING_ISSUE_CODE_VALUES = [
  'INVALID_INPUT',
  'ENGINE_VERSION_MISMATCH',
  'UNTRUSTED_CONTEXT',
  'RUBRIC_INVALID',
  'RUBRIC_NOT_FOUND',
  'TARGET_TRACK_NOT_DECLARED',
  'LOCKED_CONTEXT_INVALID',
  'LOCKED_CONTEXT_MISMATCH',
  'GRAPH_MIXED_PROJECTS',
  'GRAPH_INTEGRITY_FAILED',
  'JUDGMENT_MISSING',
  'JUDGMENT_DUPLICATE',
  'UNKNOWN_DIMENSION',
  'JUDGMENT_FOR_NOT_APPLICABLE_DIMENSION',
  'SCORE_NOT_FINITE',
  'SCORE_OUT_OF_SCALE',
  'CITATION_UNKNOWN_EVIDENCE',
  'CITATION_DUPLICATE',
  'UNWEIGHTED_PREVIEW_NOT_APPLICABLE',
] as const;
export const ScoringIssueCode = z.enum(SCORING_ISSUE_CODE_VALUES);
export type ScoringIssueCode = z.infer<typeof ScoringIssueCode>;

export const ScoringIssue = z.strictObject({
  code: ScoringIssueCode,
  path: z.string(),
  message: z.string(),
});
export type ScoringIssue = z.infer<typeof ScoringIssue>;

/** Non-fatal, neutral observations. Never accusations (invariant 25) and never score deductions. */
export const SCORING_DIAGNOSTIC_CODE_VALUES = [
  'UNATTESTED_PRIVILEGED_LEVEL',
  'UNSUPPORTED_REPO_CORROBORATION',
  'UNSUPPORTED_VERIFICATION_LABEL',
  'GRAPH_LABEL_NOT_JUSTIFIED',
  'JUDGED_VALUE_NOT_USED',
  'DUPLICATE_PROVENANCE_GROUPED',
  'INCONSISTENT_CLASSIFICATION_RESOLVED',
  'UNMAPPED_CONTRADICTION',
  'UNMAPPED_UNKNOWN',
  'LINEAGE_CONTRADICTION_IN_HISTORY',
] as const;
export const ScoringDiagnosticCode = z.enum(SCORING_DIAGNOSTIC_CODE_VALUES);
export type ScoringDiagnosticCode = z.infer<typeof ScoringDiagnosticCode>;

// -- Untrusted input: what an assessor (M5) may supply -----------------------------------------

export const Citation = z.strictObject({
  evidenceId: Uuid,
  directness: EvidenceDirectness,
  specificity: EvidenceSpecificity,
});
export type Citation = z.infer<typeof Citation>;

export const JudgmentOutcome = z.discriminatedUnion('kind', [
  /** The score is on the unit's own scale (the rubric's published scale; 0-10 for the fallback). */
  z.strictObject({ kind: z.literal('scored'), score: z.number() }),
  z.strictObject({ kind: z.literal('insufficient_evidence') }),
]);
export type JudgmentOutcome = z.infer<typeof JudgmentOutcome>;

export const DimensionJudgment = z.strictObject({
  dimensionId: DottedIdentifier,
  outcome: JudgmentOutcome,
  citations: z.array(Citation).max(SCORING_LIMITS.citationsPerJudgmentMax),
});
export type DimensionJudgment = z.infer<typeof DimensionJudgment>;

/**
 * The whole untrusted payload. Strict: there is deliberately no field for attestations, verification
 * levels, weights, rubric content or track declarations, and unknown keys are an error.
 */
export const AssessorJudgmentsInput = z.strictObject({
  engineVersion: z.literal(SCORING_ENGINE_VERSION),
  judgments: z.array(DimensionJudgment).max(SCORING_LIMITS.judgmentsMax),
});
export type AssessorJudgmentsInput = z.infer<typeof AssessorJudgmentsInput>;

/** Caller options (the judge UI or API), validated, never assessor-controlled. */
export const ScoringOptions = z.strictObject({
  unweightedPreview: z.literal('equal_weight').optional(),
});
export type ScoringOptions = z.infer<typeof ScoringOptions>;

// -- Report ------------------------------------------------------------------------------------

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const UuidList = z.array(Uuid);

export const NeedsReport = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('declared'),
    totalGroups: z.number().int().min(1),
    satisfiedGroups: z.number().int().min(0),
    coverage: Ratio,
  }),
  /** A flag, not breadth: 1 when at least one usable item was cited. Never called coverage. */
  z.strictObject({
    kind: z.literal('unspecified'),
    citationPresence: z.union([z.literal(0), z.literal(1)]),
  }),
]);
export type NeedsReport = z.infer<typeof NeedsReport>;

const dimensionBase = {
  id: DottedIdentifier,
  criterionKey: Identifier,
  name: z.string(),
  /** Weight within its criterion (1 for an official criterion). */
  weight: z.number(),
  needs: NeedsReport,
  citedEvidenceIds: UuidList,
  /** Distinct recorded contradictions that touch this dimension's cited material. */
  contradictionIds: UuidList,
  /** Number of provenance groups among the usable cited items. */
  provenanceGroupCount: z.number().int().min(0),
};

export const AssessedDimensionReport = z.strictObject({
  ...dimensionBase,
  state: z.literal('assessed'),
  scoreOnScale: z.number(),
  score10: Score10,
  evidenceStrength: Ratio,
  strongestEvidenceIds: UuidList,
  confidenceBasis: ConfidenceBasis,
  confidence: Ratio,
});
export type AssessedDimensionReport = z.infer<typeof AssessedDimensionReport>;

/** Deliberately has NO score field of any kind. */
export const InsufficientDimensionReport = z.strictObject({
  ...dimensionBase,
  state: z.literal('insufficient_evidence'),
  reason: InsufficientReason,
  confidence: z.literal(0),
});
export type InsufficientDimensionReport = z.infer<typeof InsufficientDimensionReport>;

export const DimensionReport = z.discriminatedUnion('state', [
  AssessedDimensionReport,
  InsufficientDimensionReport,
]);
export type DimensionReport = z.infer<typeof DimensionReport>;

const aggregateBase = {
  assessedWeightShare: Ratio,
  /** Declared-needs coverage; null where the rubric declares no needs. */
  coverage: Ratio.nullable(),
  /** Share of weight whose unit cited a usable item; null where needs are declared. */
  citationPresenceShare: Ratio.nullable(),
  confidence: Ratio,
};

const scoredCriterion = <S extends 'assessed' | 'partial'>(state: S) =>
  z.strictObject({
    key: Identifier,
    name: z.string(),
    weight: z.number().nullable(),
    state: z.literal(state),
    scoreOnScale: z.number(),
    score10: Score10,
    ...aggregateBase,
    dimensionIds: z.array(DottedIdentifier),
    missingDimensionIds: z.array(DottedIdentifier),
  });

export const CriterionReport = z.discriminatedUnion('state', [
  scoredCriterion('assessed'),
  scoredCriterion('partial'),
  z.strictObject({
    key: Identifier,
    name: z.string(),
    weight: z.number().nullable(),
    state: z.literal('insufficient_evidence'),
    ...aggregateBase,
    dimensionIds: z.array(DottedIdentifier),
    missingDimensionIds: z.array(DottedIdentifier),
  }),
  z.strictObject({
    key: Identifier,
    name: z.string(),
    weight: z.number().nullable(),
    state: z.literal('not_applicable'),
    reason: z.literal('no_declared_tracks'),
  }),
]);
export type CriterionReport = z.infer<typeof CriterionReport>;

const scoredOverall = <S extends 'scored' | 'scored_partial'>(state: S) =>
  z.strictObject({
    state: z.literal(state),
    weightBasis: z.enum(['official', 'fallback']),
    scoreOnScale: z.number(),
    score10: Score10,
    ...aggregateBase,
    missingCriterionKeys: z.array(Identifier),
  });

export const OverallReport = z.discriminatedUnion('state', [
  scoredOverall('scored'),
  scoredOverall('scored_partial'),
  z.strictObject({
    state: z.literal('insufficient_evidence'),
    weightBasis: z.enum(['official', 'fallback']),
    reason: z.literal('assessed_weight_below_threshold'),
    ...aggregateBase,
    missingCriterionKeys: z.array(Identifier),
  }),
  /** An unweighted official rubric never yields an official overall number. */
  z.strictObject({
    state: z.literal('not_computed'),
    weightBasis: z.literal('unweighted_official'),
    reason: z.literal('unweighted_official_rubric'),
  }),
]);
export type OverallReport = z.infer<typeof OverallReport>;

const previewBase = {
  kind: z.literal('unofficial_equal_weight_preview'),
  official: z.literal(false),
  weightBasis: z.literal('equal_assumed'),
  notice: z.literal(UNOFFICIAL_PREVIEW_NOTICE),
};

const scoredPreview = <S extends 'scored' | 'scored_partial'>(state: S) =>
  z.strictObject({
    ...previewBase,
    state: z.literal(state),
    scoreOnScale: z.number(),
    score10: Score10,
    ...aggregateBase,
    missingCriterionKeys: z.array(Identifier),
  });

/**
 * Reported OUTSIDE `overall`, only on an explicit request, and always labeled unofficial. Its
 * `kind`, `official: false`, `weightBasis` and `notice` are literals of the schema.
 */
export const UnofficialPreview = z.discriminatedUnion('state', [
  scoredPreview('scored'),
  scoredPreview('scored_partial'),
  z.strictObject({
    ...previewBase,
    state: z.literal('insufficient_evidence'),
    ...aggregateBase,
    missingCriterionKeys: z.array(Identifier),
  }),
]);
export type UnofficialPreview = z.infer<typeof UnofficialPreview>;

export const RubricIdentity = z.strictObject({
  source: RubricSource,
  /** `fallback-rubric/v1` for the fallback, null for an official rubric. */
  rubricVersion: z.string().nullable(),
  contextVersionId: Uuid.nullable(),
  contextContentHash: Sha256Hex.nullable(),
  name: z.string(),
  scope: z.enum(SCORING_TARGET_KIND_VALUES),
  trackKey: Identifier.nullable(),
  weightBasis: RubricWeightBasis,
  needsBasis: NeedsBasis,
  scale: z.strictObject({ min: z.number(), max: z.number() }),
  /** True only for a rubric published by the organizers in the locked Event Context. */
  official: z.boolean(),
  fingerprint: Sha256Hex,
});
export type RubricIdentity = z.infer<typeof RubricIdentity>;

/**
 * A claim's supersession chain, oldest to newest. `recordedLevels` are stored LABELS, shown for
 * context only: a label is never proof of truth and never an input of any formula.
 */
export const ClaimLineage = z.strictObject({
  headClaimId: Uuid,
  claimIds: UuidList,
  recordedLevels: z.array(VerificationLevel),
  everContradicted: z.boolean(),
  contradictionIds: UuidList,
});
export type ClaimLineage = z.infer<typeof ClaimLineage>;

export const ScoringDiagnostic = z.strictObject({
  code: ScoringDiagnosticCode,
  path: z.string(),
  entityIds: z.array(z.string()),
  message: z.string(),
});
export type ScoringDiagnostic = z.infer<typeof ScoringDiagnostic>;

/** Fixed statements about what this report does NOT establish. Literals, so they cannot be dropped. */
export const ScoreReportNotices = z.strictObject({
  contradictionCoverage: z.literal('recorded_only'),
  semanticRelevance: z.literal('not_verified'),
  claimLabels: z.literal('never_proof_of_truth'),
  parameterStatus: z.literal('heuristic_not_calibrated'),
  confidenceMeaning: z.literal('index_not_probability'),
});
export type ScoreReportNotices = z.infer<typeof ScoreReportNotices>;

export const ScoreReportBody = z.strictObject({
  engineVersion: z.literal(SCORING_ENGINE_VERSION),
  /** Hash of every parameter and the fallback rubric definition the engine used. */
  parametersHash: Sha256Hex,
  /** Hash of the engine version, parameters, rubric, options, judgments, graph facts and track context. */
  inputFingerprint: Sha256Hex,
  /** Hash of the evidence-graph facts that can influence the output (not free text). */
  graphFingerprint: Sha256Hex,
  rubric: RubricIdentity,
  dimensions: z.array(DimensionReport),
  criteria: z.array(CriterionReport),
  overall: OverallReport,
  unofficialPreview: UnofficialPreview.nullable(),
  claimLineages: z.array(ClaimLineage),
  diagnostics: z.array(ScoringDiagnostic),
  notices: ScoreReportNotices,
});
export type ScoreReportBody = z.infer<typeof ScoreReportBody>;

/** The canonical report; `outputHash` covers every other field. */
export const ScoreReport = ScoreReportBody.extend({ outputHash: Sha256Hex });
export type ScoreReport = z.infer<typeof ScoreReport>;
