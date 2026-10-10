import { z } from 'zod';
import { ANALYSIS_RUN_FAILURE_CATEGORY_VALUES, UnknownType } from './enums.js';
import {
  ClaimText,
  ContradictionDescription,
  ContradictionSideType,
  EvidenceRelationType,
  EvidenceText,
  isStorableGraphText,
  LocalRef,
  UnknownText,
} from './evidence-graph.js';
import { DottedIdentifier } from './primitives.js';
import {
  EvidenceDirectness,
  EvidenceSpecificity,
  JudgmentOutcome,
  SCORING_LIMITS,
} from './scoring.js';

/*
 * M5 vocabularies, strict model-OUTPUT schemas and run limits (docs/milestones/M5-design.md §4.3, §5.2,
 * §9.1, §12.4). Layer 0: no behavior beyond validation.
 *
 * Every model output is UNTRUSTED. These schemas are the first of the two validation gates
 * (invariant 19): shape only. They are all `strictObject`, so a model that smuggles a persisted ID, an
 * `origin`, a `verificationLevel`, a weight, a confidence number or an overall score is REJECTED, not
 * ignored. The second gate (domain validation: handles exist, quotes are found, units belong to the
 * rubric, ...) is deterministic code in later phases.
 *
 * The model refers to records only through code-assigned, request-scoped HANDLES (`P-0001`, `C-001`,
 * `E-001`, `X-001`). Handles are closed-set identifiers supplied by code; they are never persisted
 * IDs (invariant 20, design decision N1).
 */

// -- Vocabularies --------------------------------------------------------------------------------

/** Model-backed pipeline stages (design §3.2). */
export const ASSESSMENT_STAGE_VALUES = [
  'claim_extraction',
  'evidence_interpretation',
  'fidelity_review',
  'relation_matching',
  'relation_verification',
  'contradiction_detection',
  'unknown_identification',
  'dimension_assessment',
  'critic',
] as const;
export const AssessmentStage = z.enum(ASSESSMENT_STAGE_VALUES);
export type AssessmentStage = z.infer<typeof AssessmentStage>;

/** How a provider produced its answer. Only `live` is a genuinely model-backed assessment. */
export const PROVIDER_MODE_VALUES = ['live', 'replay', 'scripted'] as const;
export const ProviderMode = z.enum(PROVIDER_MODE_VALUES);
export type ProviderMode = z.infer<typeof ProviderMode>;

/** Provider-neutral failure categories (SDK and transport errors are mapped to these at the adapter boundary). */
export const LLM_FAILURE_CATEGORY_VALUES = [
  'timeout',
  'rate_limited',
  'provider_unavailable',
  'refused',
  'truncated',
  'auth',
  'bad_request',
  'cancelled',
  'budget_exceeded',
  'replay_miss',
] as const;
export const LlmFailureCategory = z.enum(LLM_FAILURE_CATEGORY_VALUES);
export type LlmFailureCategory = z.infer<typeof LlmFailureCategory>;

/**
 * Whether a failed attempt could have cost money. `not_sent`: the request provably never reached the
 * provider (or was rejected before any generation); `sent_unknown`: it may have been processed.
 */
export const SEND_STATE_VALUES = ['not_sent', 'sent_unknown'] as const;
export const SendState = z.enum(SEND_STATE_VALUES);
export type SendState = z.infer<typeof SendState>;

/** Why the local spending guard refused to start an attempt. */
export const BUDGET_DENIAL_REASON_VALUES = [
  'calls',
  'input_tokens',
  'output_tokens',
  'cost',
  'wall_clock',
  'per_call_input',
  'unpriced_model',
] as const;
export const BudgetDenialReason = z.enum(BUDGET_DENIAL_REASON_VALUES);
export type BudgetDenialReason = z.infer<typeof BudgetDenialReason>;

/** Lifecycle of one ledger row: `reserved` → exactly one of the other three. */
export const CALL_STATE_VALUES = ['reserved', 'settled', 'released', 'unknown'] as const;
export const CallState = z.enum(CALL_STATE_VALUES);
export type CallState = z.infer<typeof CallState>;

/** How the usage of a ledger row is known. `unknown_reserved` is counted at the full reservation. */
export const USAGE_BASIS_VALUES = ['measured', 'estimated', 'unknown_reserved'] as const;
export const UsageBasis = z.enum(USAGE_BASIS_VALUES);
export type UsageBasis = z.infer<typeof UsageBasis>;

/**
 * Run failure categories for an assessment run. `budget_exceeded` (design D6) joined the shared tuple in migration 0010; a CHECK
 * restricts it to `pre_interview_assessment` runs. Kept as a separate name for the assessment API.
 */
export const ASSESSMENT_RUN_FAILURE_CATEGORY_VALUES = ANALYSIS_RUN_FAILURE_CATEGORY_VALUES;
export const AssessmentRunFailureCategory = z.enum(ASSESSMENT_RUN_FAILURE_CATEGORY_VALUES);
export type AssessmentRunFailureCategory = z.infer<typeof AssessmentRunFailureCategory>;

export const CRITIC_FINDING_CODE_VALUES = [
  'unsupported_judgment',
  'missing_evidence_as_negative',
  'team_claim_overreliance',
  'citation_not_relevant',
  'rubric_drift',
  'raw_signal_reasoning',
  'ignored_contradiction',
  'injection_suspected',
  'score_anchor_mismatch',
  'classification_overstated',
] as const;
export const CriticFindingCode = z.enum(CRITIC_FINDING_CODE_VALUES);
export type CriticFindingCode = z.infer<typeof CriticFindingCode>;

export const CRITIC_SEVERITY_VALUES = ['blocking', 'minor'] as const;
export const CriticSeverity = z.enum(CRITIC_SEVERITY_VALUES);
export type CriticSeverity = z.infer<typeof CriticSeverity>;

export const FIDELITY_VERDICT_VALUES = [
  'faithful',
  'overstated',
  'unfaithful',
  'cannot_tell',
] as const;
export const FidelityVerdict = z.enum(FIDELITY_VERDICT_VALUES);
export type FidelityVerdict = z.infer<typeof FidelityVerdict>;

export const RELATION_VERDICT_VALUES = [
  'supports',
  'contradicts',
  'unrelated',
  'cannot_tell',
] as const;
export const RelationVerdict = z.enum(RELATION_VERDICT_VALUES);
export type RelationVerdict = z.infer<typeof RelationVerdict>;

/** Closed codes a dimension assessor may attach instead of free text. */
export const DIMENSION_LIMITATION_CODE_VALUES = [
  'only_team_statements',
  'sampled_source',
  'partial_capture',
  'pre_interview_only',
  'unresolved_contradiction',
] as const;
export const DimensionLimitationCode = z.enum(DIMENSION_LIMITATION_CODE_VALUES);
export type DimensionLimitationCode = z.infer<typeof DimensionLimitationCode>;

/** Unknown types a MODEL may propose. `missing` is code-authored from snapshot status, never a model guess. */
export const ModelUnknownType = UnknownType.exclude(['missing']);
export type ModelUnknownType = z.infer<typeof ModelUnknownType>;

// -- Handles and bounded free text -----------------------------------------------------------------

export const PASSAGE_HANDLE_PATTERN = '^P-\\d{4,6}$';
export const CLAIM_HANDLE_PATTERN = '^C-\\d{3,5}$';
export const EVIDENCE_HANDLE_PATTERN = '^E-\\d{3,5}$';
export const PAIR_HANDLE_PATTERN = '^X-\\d{3,5}$';

export const PassageHandle = z.string().regex(new RegExp(PASSAGE_HANDLE_PATTERN));
export const ClaimHandle = z.string().regex(new RegExp(CLAIM_HANDLE_PATTERN));
export const EvidenceHandle = z.string().regex(new RegExp(EVIDENCE_HANDLE_PATTERN));
export const PairHandle = z.string().regex(new RegExp(PAIR_HANDLE_PATTERN));
/** A claim or an evidence handle (fidelity review reviews both). */
export const ItemHandle = z.string().regex(/^(?:C-\d{3,5}|E-\d{3,5})$/);

export const ASSESSMENT_OUTPUT_LIMITS = {
  quoteMinCodePoints: 8,
  quoteMaxCodePoints: 2_000,
  rationaleMaxChars: 1_200,
  noteMaxChars: 240,
  claimsPerCall: 25,
  evidencePerCall: 40,
  verdictsPerFidelityCall: 100,
  relationsPerCall: 120,
  verdictsPerRelationCall: 20,
  contradictionsPerCall: 20,
  unknownsPerCall: 20,
  refsPerUnknown: 50,
  findingsPerUnit: 20,
  handlesPerFinding: 20,
  limitationsPerUnit: 10,
} as const;

function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) count += 1; // iterates by code point
  return count;
}

/**
 * A verbatim quotation. It is NOT normalized (the code locates it byte-for-byte in the stored text) and is
 * never trusted as provenance: code derives the span and excerpt from the located position.
 */
export const Quote = z
  .string()
  .max(ASSESSMENT_OUTPUT_LIMITS.quoteMaxCodePoints * 4)
  .refine(
    (value) => {
      const length = codePointLength(value);
      return (
        length >= ASSESSMENT_OUTPUT_LIMITS.quoteMinCodePoints &&
        length <= ASSESSMENT_OUTPUT_LIMITS.quoteMaxCodePoints
      );
    },
    { message: 'a quote must be 8 to 2,000 code points' },
  )
  .refine(isStorableGraphText, 'contains control characters or malformed Unicode');

function prose(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine(isStorableGraphText, 'contains control characters or malformed Unicode');
}

// -- Stage output schemas ----------------------------------------------------------------------------

/** S2 `claim-extraction/v1` — statement passages only. */
export const ClaimExtractionOutput = z.strictObject({
  claims: z
    .array(
      z.strictObject({
        ref: LocalRef,
        text: ClaimText,
        passage: PassageHandle,
        quote: Quote,
      }),
    )
    .max(ASSESSMENT_OUTPUT_LIMITS.claimsPerCall),
});
export type ClaimExtractionOutput = z.infer<typeof ClaimExtractionOutput>;

/** S3 `evidence-interpretation/v1` — `kind` is deliberately not a field: code sets `fact`. */
export const EvidenceInterpretationOutput = z.strictObject({
  evidence: z
    .array(
      z.strictObject({
        ref: LocalRef,
        text: EvidenceText,
        passage: PassageHandle,
        quote: Quote,
      }),
    )
    .max(ASSESSMENT_OUTPUT_LIMITS.evidencePerCall),
});
export type EvidenceInterpretationOutput = z.infer<typeof EvidenceInterpretationOutput>;

/** S3b `fidelity-review/v1` — each item reviewed alone. */
export const FidelityReviewOutput = z.strictObject({
  verdicts: z
    .array(z.strictObject({ item: ItemHandle, verdict: FidelityVerdict }))
    .max(ASSESSMENT_OUTPUT_LIMITS.verdictsPerFidelityCall),
});
export type FidelityReviewOutput = z.infer<typeof FidelityReviewOutput>;

/** S4 `relation-matching/v1` — handles only. */
export const RelationMatchingOutput = z.strictObject({
  relations: z
    .array(
      z.strictObject({
        claim: ClaimHandle,
        evidence: EvidenceHandle,
        type: EvidenceRelationType,
      }),
    )
    .max(ASSESSMENT_OUTPUT_LIMITS.relationsPerCall),
});
export type RelationMatchingOutput = z.infer<typeof RelationMatchingOutput>;

/** S4b `relation-verification/v1` — each pair judged alone. */
export const RelationVerificationOutput = z.strictObject({
  verdicts: z
    .array(z.strictObject({ pair: PairHandle, verdict: RelationVerdict }))
    .max(ASSESSMENT_OUTPUT_LIMITS.verdictsPerRelationCall),
});
export type RelationVerificationOutput = z.infer<typeof RelationVerificationOutput>;

const ContradictionSide = z
  .strictObject({
    type: ContradictionSideType,
    handle: ItemHandle,
  })
  .refine((side) => side.handle.startsWith(side.type === 'claim' ? 'C-' : 'E-'), {
    message: 'the handle prefix must match the side type',
  });

/** S5 `contradiction-detection/v1`. A contradiction is a neutral note for the judge, never an accusation. */
export const ContradictionDetectionOutput = z.strictObject({
  contradictions: z
    .array(
      z.strictObject({
        sideA: ContradictionSide,
        sideB: ContradictionSide,
        description: ContradictionDescription,
      }),
    )
    .max(ASSESSMENT_OUTPUT_LIMITS.contradictionsPerCall),
});
export type ContradictionDetectionOutput = z.infer<typeof ContradictionDetectionOutput>;

/** S6 `unknown-identification/v1`. `missing` is excluded: absence is code-authored. */
export const UnknownIdentificationOutput = z.strictObject({
  unknowns: z
    .array(
      z.strictObject({
        unknownType: ModelUnknownType,
        text: UnknownText,
        claims: z.array(ClaimHandle).max(ASSESSMENT_OUTPUT_LIMITS.refsPerUnknown),
        evidence: z.array(EvidenceHandle).max(ASSESSMENT_OUTPUT_LIMITS.refsPerUnknown),
      }),
    )
    .max(ASSESSMENT_OUTPUT_LIMITS.unknownsPerCall),
});
export type UnknownIdentificationOutput = z.infer<typeof UnknownIdentificationOutput>;

/**
 * S10 `dimension-assessment/v1`. Maps onto the M4 `AssessorJudgmentsInput` after code resolves handles. There
 * is no field for a criterion total, overall score, weight, confidence, verification level or ranking.
 */
export const DimensionAssessmentOutput = z.strictObject({
  dimensionId: DottedIdentifier,
  outcome: JudgmentOutcome.refine(
    (outcome) => outcome.kind !== 'scored' || Number.isFinite(outcome.score),
    { message: 'a score must be finite' },
  ),
  citations: z
    .array(
      z.strictObject({
        evidence: EvidenceHandle,
        directness: EvidenceDirectness,
        specificity: EvidenceSpecificity,
        note: prose(ASSESSMENT_OUTPUT_LIMITS.noteMaxChars),
      }),
    )
    .max(SCORING_LIMITS.citationsPerJudgmentMax),
  rationale: prose(ASSESSMENT_OUTPUT_LIMITS.rationaleMaxChars),
  limitations: z.array(DimensionLimitationCode).max(ASSESSMENT_OUTPUT_LIMITS.limitationsPerUnit),
});
export type DimensionAssessmentOutput = z.infer<typeof DimensionAssessmentOutput>;

/**
 * S11 `critic/v1`. Findings only: the schema has no score, replacement judgment or verdict number, so the critic
 * cannot rewrite anything (AI_PIPELINE §6).
 */
export const CriticOutput = z.strictObject({
  unit: DottedIdentifier,
  findings: z
    .array(
      z.strictObject({
        code: CriticFindingCode,
        severity: CriticSeverity,
        evidence: z.array(EvidenceHandle).max(ASSESSMENT_OUTPUT_LIMITS.handlesPerFinding),
        note: prose(ASSESSMENT_OUTPUT_LIMITS.noteMaxChars),
      }),
    )
    .max(ASSESSMENT_OUTPUT_LIMITS.findingsPerUnit),
});
export type CriticOutput = z.infer<typeof CriticOutput>;

/** The output schema of every stage. */
export const ASSESSMENT_STAGE_OUTPUT_SCHEMAS = {
  claim_extraction: ClaimExtractionOutput,
  evidence_interpretation: EvidenceInterpretationOutput,
  fidelity_review: FidelityReviewOutput,
  relation_matching: RelationMatchingOutput,
  relation_verification: RelationVerificationOutput,
  contradiction_detection: ContradictionDetectionOutput,
  unknown_identification: UnknownIdentificationOutput,
  dimension_assessment: DimensionAssessmentOutput,
  critic: CriticOutput,
} as const satisfies Record<AssessmentStage, z.ZodType>;

export interface StageOutputIssue {
  readonly path: string;
  /** The Zod issue code only: never the offending value or Zod's message (they can echo model/project text). */
  readonly code: string;
}

export type StageOutputResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issues: readonly StageOutputIssue[] };

/**
 * Gate 1 (shape) for any stage. The issues carry paths and codes only, so a repair prompt built from them cannot
 * smuggle model-produced text back into a later prompt. At most 50 issues are returned.
 */
export function parseStageOutput(stage: AssessmentStage, json: unknown): StageOutputResult {
  const parsed = ASSESSMENT_STAGE_OUTPUT_SCHEMAS[stage].safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.slice(0, 50).map((issue) => ({
      path: issue.path.map(String).join('.'),
      code: issue.code,
    })),
  };
}

// -- Run limits and prices ---------------------------------------------------------------------------

/** Defaults are GUARDS, not forecasts (design §12.4). Costs are nano-USD (1e-9 USD) so every figure is an exact integer. */
export const ASSESSMENT_RUN_LIMIT_DEFAULTS = {
  maxCalls: 150,
  maxInputTokens: 1_500_000,
  maxOutputTokens: 250_000,
  maxCostNanoUsd: 3_000_000_000,
  maxReservedInputTokensPerCall: 100_000,
  runWallClockMs: 7_200_000,
} as const;

export const ASSESSMENT_RUN_LIMIT_MAXIMA = {
  maxCalls: 300,
  maxInputTokens: 3_000_000,
  maxOutputTokens: 500_000,
  maxCostNanoUsd: 10_000_000_000,
  maxReservedInputTokensPerCall: 200_000,
  runWallClockMs: 14_400_000,
} as const;

/** Per-attempt timeout bounds (milliseconds). */
export const ASSESSMENT_CALL_TIMEOUT_MS = { default: 120_000, max: 300_000 } as const;

function limit(key: keyof typeof ASSESSMENT_RUN_LIMIT_DEFAULTS) {
  return z
    .number()
    .int()
    .min(1)
    .max(ASSESSMENT_RUN_LIMIT_MAXIMA[key])
    .default(ASSESSMENT_RUN_LIMIT_DEFAULTS[key]);
}

/**
 * The configured LOCAL SPENDING GUARD of one run. It stops new provider attempts when the computed total would
 * cross a limit; it is not a provider billing limit and cannot guarantee the provider's invoice.
 */
export const AssessmentRunLimits = z.strictObject({
  /** Counts ATTEMPTS: every transient retry is one more. */
  maxCalls: limit('maxCalls'),
  maxInputTokens: limit('maxInputTokens'),
  maxOutputTokens: limit('maxOutputTokens'),
  maxCostNanoUsd: limit('maxCostNanoUsd'),
  /** A bound on the reserved (byte-based, conservative) input of one attempt. */
  maxReservedInputTokensPerCall: limit('maxReservedInputTokensPerCall'),
  runWallClockMs: limit('runWallClockMs'),
});
export type AssessmentRunLimits = z.infer<typeof AssessmentRunLimits>;

/** Versioned, dated price metadata. Integers only: nano-USD per token. */
export const PriceTable = z.strictObject({
  id: z.string().regex(/^prices\/v\d+$/),
  effectiveDate: z.iso.date(),
  currency: z.literal('USD'),
  unit: z.literal('nano_usd_per_token'),
  /** Where the figures came from, and that they are unverified against the provider. */
  source: z.string().min(1).max(500),
  models: z.record(
    z.string().min(1).max(100),
    z.strictObject({
      inputNanoUsdPerToken: z.number().int().min(0),
      outputNanoUsdPerToken: z.number().int().min(0),
    }),
  ),
});
export type PriceTable = z.infer<typeof PriceTable>;

// -- Persistence vocabularies (P4; shared by the database CHECK constraints) --------------------------------------------

/** The `analysis_runs.run_type` of an assessment run. */
export const ASSESSMENT_RUN_TYPE = 'pre_interview_assessment' as const;

/** `assess` reuses an equal assessment; `reassess` is an explicit new version (design §8.6). */
export const ASSESSMENT_REQUEST_MODE_VALUES = ['assess', 'reassess'] as const;
export const AssessmentRequestMode = z.enum(ASSESSMENT_REQUEST_MODE_VALUES);
export type AssessmentRequestMode = z.infer<typeof AssessmentRequestMode>;

/** What an extraction holds: the source-derived graph, or the Event-Context reference evidence set. */
export const EXTRACTION_KIND_VALUES = ['source', 'context_evidence'] as const;
export const ExtractionKind = z.enum(EXTRACTION_KIND_VALUES);
export type ExtractionKind = z.infer<typeof ExtractionKind>;

export const GRAPH_RECORD_TYPE_VALUES = [
  'claim',
  'evidence',
  'relation',
  'unknown',
  'contradiction',
] as const;
export type GraphRecordType = (typeof GRAPH_RECORD_TYPE_VALUES)[number];

/** What an evidence record of an extraction IS (code-authored): a team statement, an interpreted fact, or an Event-Context reference. */
export const EXTRACTION_EVIDENCE_ROLE_VALUES = [
  'statement',
  'interpreted_fact',
  'event_reference',
] as const;
export type ExtractionEvidenceRole = (typeof EXTRACTION_EVIDENCE_ROLE_VALUES)[number];

/** Why a relation exists (design §4.5). */
export const RELATION_BASIS_VALUES = [
  'source_statement',
  'independent_observation',
  'team_restatement',
] as const;
export type RelationBasis = (typeof RELATION_BASIS_VALUES)[number];

/** The kind and applicability of an Event-Context reference item (code-authored from the pinned locked document). */
export const REFERENCE_KIND_VALUES = [
  'track_definition',
  'rule',
  'submission_requirement',
] as const;
export const REFERENCE_APPLICABILITY_VALUES = [
  'declared_track_definition',
  'track_specific_requirement',
  'overall_rule',
] as const;

/** Whether the bounded model answer was retained in the ledger, and if not why. */
export const RESPONSE_RECORD_STATE_VALUES = [
  'stored',
  'too_large',
  'unserializable',
  'none',
] as const;

/** Where the run ended. Mirrors the terminal `analysis_runs` states. */
export const ASSESSMENT_RUN_OUTCOME_VALUES = ['succeeded', 'failed', 'cancelled'] as const;
export type AssessmentRunOutcome = (typeof ASSESSMENT_RUN_OUTCOME_VALUES)[number];
