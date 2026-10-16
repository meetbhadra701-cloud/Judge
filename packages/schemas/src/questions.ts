import { z } from 'zod';
import type { ProviderMode } from './assessment.js';
import { QuestionMode } from './enums.js';
import { Uuid } from './primitives.js';

/*
 * M6 vocabularies, the strict model-OUTPUT schema of the candidate-question stage, and the HTTP contract of a question set (docs/milestones/M6 report).
 * Layer 0: shape only. The uncertainty analysis and the ranking are deterministic code in `@judge-copilot/uncertainty` and `@judge-copilot/questions`.
 *
 * A model only PHRASES candidate questions. It refers to records through code-assigned request-scoped HANDLES (`O-001` opportunities, `D-001`
 * dimensions, `X-001` unknowns, `C-001` claims, `E-001` evidence), never through persisted ids, and it can propose neither a rank, a score nor a
 * weight. Every handle is validated against the frozen assessment context by code (invariant 20).
 */

/** The policy of the deterministic engine: the analysis rules, the ranking formula and the selection algorithm. A change of any of them is a new version. */
export const QUESTION_POLICY_VERSION = 'question-engine/v2' as const;
/**
 * `question-engine/v1` (M6) stored sets whose shortfall explanation could not tell a repeat from a candidate whose value was below the minimum: it called every
 * candidate left out of a pool of five or more a repeat. v2 (M6-R1) selects exactly as v1 did (same ranking, same overlap, same threshold) and names the real
 * stopping cause. A stored v1 set is never rewritten: it keeps its policy version and its recorded wording, and the page says so.
 */
export const QUESTION_POLICY_VERSION_V1 = 'question-engine/v1' as const;
export const QUESTION_POLICY_VERSION_VALUES = [
  QUESTION_POLICY_VERSION_V1,
  QUESTION_POLICY_VERSION,
] as const;
export type QuestionPolicyVersion = (typeof QUESTION_POLICY_VERSION_VALUES)[number];
export const UNCERTAINTY_ENGINE_VERSION = 'uncertainty-engine/v1' as const;

/** The one model-backed stage M6 adds. It is a separate vocabulary from the assessment pipeline's stages (and from the ledger's CHECK). */
export const QUESTION_STAGE_VALUES = ['question_generation'] as const;
export const QuestionStage = z.enum(QUESTION_STAGE_VALUES);
export type QuestionStage = z.infer<typeof QuestionStage>;

/** What an uncertainty opportunity is ABOUT. Every kind is an absence of knowledge or a recorded inconsistency: none is a finding against the project. */
export const UNCERTAINTY_KIND_VALUES = [
  'dimension_not_assessed',
  'dimension_rests_on_claims',
  'claim_unverified',
  'contradiction_recorded',
  'unknown_recorded',
  'source_missing',
  'coverage_partial',
  'requirement_unaddressed',
  'track_rubric_not_assessed',
  'thin_evidence',
] as const;
export const UncertaintyKind = z.enum(UNCERTAINTY_KIND_VALUES);
export type UncertaintyKind = z.infer<typeof UncertaintyKind>;

/** How much the uncertainty could change what the judge understands about the project. Not a probability, not a score. */
export const UNCERTAINTY_SEVERITY_VALUES = ['critical', 'high', 'moderate', 'low'] as const;
export const UncertaintySeverity = z.enum(UNCERTAINTY_SEVERITY_VALUES);
export type UncertaintySeverity = z.infer<typeof UncertaintySeverity>;

/** What kind of answer or demonstration would clarify an issue. */
export const EXPECTED_INFORMATION_VALUES = [
  'explanation',
  'code_walkthrough',
  'live_demonstration',
  'link_or_document',
  'measurement',
] as const;
export const ExpectedInformation = z.enum(EXPECTED_INFORMATION_VALUES);
export type ExpectedInformation = z.infer<typeof ExpectedInformation>;

/** How a candidate may relate to the competing interpretations of an uncertainty, as PROPOSED by the phrasing model. Ordinal, capped by code. */
export const DISTINGUISHING_VALUES = ['weak', 'moderate', 'strong'] as const;
export const Distinguishing = z.enum(DISTINGUISHING_VALUES);
export type Distinguishing = z.infer<typeof Distinguishing>;

/** How long answering would take, as PROPOSED by the phrasing model. Ordinal; the ranking uses the larger of this and the mode's own floor. */
export const EFFORT_VALUES = ['brief', 'moderate', 'extended'] as const;
export const Effort = z.enum(EFFORT_VALUES);
export type Effort = z.infer<typeof Effort>;

/** Why a candidate was refused. Stable codes (never free text) so a refusal can be counted, tested and shown. */
export const CANDIDATE_REJECTION_VALUES = [
  'unknown_opportunity_handle',
  'unknown_dimension_handle',
  'unknown_reference_handle',
  'reference_outside_opportunities',
  'dimension_outside_opportunities',
  'no_opportunity',
  'empty_question',
  'question_too_long',
  'not_a_single_question',
  'accusatory_wording',
  'presupposes_unverified_claim',
  'contains_markup_or_link',
  'empty_reason',
  'duplicate_of_candidate',
  'exceeds_per_opportunity_limit',
] as const;
export const CandidateRejection = z.enum(CANDIDATE_REJECTION_VALUES);
export type CandidateRejection = z.infer<typeof CandidateRejection>;

/** Why a question set holds fewer than five questions. */
export const QUESTION_SHORTFALL_VALUES = [
  'no_uncertainty',
  'no_valid_candidates',
  'fewer_defensible_candidates',
  'redundant_candidates',
  // question-engine/v2 (M6-R1)
  'below_minimum_value',
  'mixed_causes',
] as const;
export const QuestionShortfall = z.enum(QUESTION_SHORTFALL_VALUES);
export type QuestionShortfall = z.infer<typeof QuestionShortfall>;

export const QUESTION_SET_SIZE = 5 as const;

export const QUESTION_LIMITS = {
  /** A question is one sentence or two: bounded so it can be read aloud in an interview. */
  questionMaxChars: 400,
  reasonMaxChars: 600,
  candidatesMax: 40,
  /** At most this many candidates per opportunity are considered (a model cannot flood the ranking with variants of one issue). */
  perOpportunityMax: 3,
  referencesPerCandidateMax: 12,
  handlesPerCandidateMax: 6,
} as const;

const Handle = z.string().regex(/^[A-Z]-[0-9]{3,4}$/);

/**
 * One candidate as a model may write it. Strict: a smuggled id, rank, score, weight, evidence text or any other key is an error, not ignored.
 * `distinguishes` and `effort` are PROPOSALS: code accepts them only up to the ceiling its own tables give for the uncertainty (they can lower a
 * candidate's value, never raise it above what the opportunity itself supports).
 */
export const CandidateQuestionOutput = z.strictObject({
  mode: QuestionMode,
  text: z.string().max(QUESTION_LIMITS.questionMaxChars * 4),
  reason: z.string().max(QUESTION_LIMITS.reasonMaxChars * 4),
  expectedInformation: z.array(ExpectedInformation).min(1).max(EXPECTED_INFORMATION_VALUES.length),
  opportunities: z.array(Handle).min(1).max(QUESTION_LIMITS.handlesPerCandidateMax),
  dimensions: z.array(Handle).max(QUESTION_LIMITS.handlesPerCandidateMax),
  /** Unknown, claim or evidence handles the question draws on; each must belong to one of the cited opportunities. */
  references: z.array(Handle).max(QUESTION_LIMITS.referencesPerCandidateMax),
  distinguishes: Distinguishing,
  effort: Effort,
});
export type CandidateQuestionOutput = z.infer<typeof CandidateQuestionOutput>;

export const QuestionCandidatesOutput = z.strictObject({
  candidates: z.array(CandidateQuestionOutput).max(QUESTION_LIMITS.candidatesMax),
});
export type QuestionCandidatesOutput = z.infer<typeof QuestionCandidatesOutput>;

export const QUESTION_OUTPUT_SCHEMA_ID = 'question-candidates' as const;
export const QUESTION_OUTPUT_SCHEMA_VERSION = 'v1' as const;

// -- The HTTP contract of a published question set ---------------------------------------------------------------------------------------

/** A reference a question or an opportunity carries, resolved to what the judge can read. Ids are the real stored identifiers. */
export interface QuestionReferenceView {
  readonly type:
    | 'dimension'
    | 'claim'
    | 'evidence'
    | 'unknown'
    | 'contradiction'
    | 'requirement'
    | 'coverage'
    | 'track';
  readonly id: string;
  /** A short, bounded, human-readable label (a criterion name, a claim sentence, an unknown's text). Project-supplied text is data, shown escaped. */
  readonly label: string;
  /** For a claim or evidence item: its recorded verification label (never proof of truth). */
  readonly verificationLevel?: string | null;
}

export interface UncertaintyOpportunityView {
  readonly id: string;
  readonly ordinal: number;
  readonly kind: UncertaintyKind;
  readonly severity: UncertaintySeverity;
  /** Rubric dimension ids this uncertainty bears on (empty for an uncertainty that is not about a scored dimension). */
  readonly dimensionIds: readonly string[];
  /** The neutral, code-written account of what is unknown or contradictory. */
  readonly observation: string;
  readonly references: readonly QuestionReferenceView[];
}

export interface SelectedQuestionView {
  readonly id: string;
  readonly rank: number;
  readonly mode: QuestionMode;
  readonly text: string;
  /** Why this matters to the event's rubric. */
  readonly reason: string;
  readonly expectedInformation: readonly ExpectedInformation[];
  readonly dimensions: readonly {
    readonly id: string;
    readonly name: string;
    readonly weightShare: number | null;
  }[];
  readonly opportunityIds: readonly string[];
  readonly references: readonly QuestionReferenceView[];
  /** The ranking value in basis points: a deterministic ordering number of this policy, NOT a probability and not calibrated. */
  readonly rankingValueBp: number;
}

export interface QuestionSetGenerationView {
  readonly providerMode: ProviderMode;
  readonly providerId: string;
  /** True for a replay or scripted provider: the questions were NOT phrased by a model. */
  readonly demonstration: boolean;
  readonly promptId: string;
  readonly promptVersion: string;
  readonly promptTemplateHash: string;
  readonly models: { readonly questions: string } | null;
}

export interface QuestionSetView {
  readonly id: string;
  readonly projectId: string;
  readonly assessmentId: string;
  readonly assessmentVersionNumber: number;
  readonly contextVersionId: string;
  readonly createdAt: string;
  readonly policyVersion: QuestionPolicyVersion;
  readonly inputHash: string;
  readonly generation: QuestionSetGenerationView;
  /** Whether the assessment this set belongs to still verifies. When false the questions are withheld (fail closed). */
  readonly assessmentVerified: boolean;
  readonly questions: readonly SelectedQuestionView[];
  /** Why there are fewer than five (null when there are five). */
  readonly shortfall: {
    readonly code: QuestionShortfall;
    readonly explanation: string;
    readonly candidateCount: number;
    /**
     * Valid candidates that were NOT selected and why (question-engine/v2): `redundant` largely repeated an already selected question; `belowMinimum` would not
     * be worth interview time even as the first question. Null for a v1 set, which did not record the split.
     */
    readonly excluded: { readonly redundant: number; readonly belowMinimum: number } | null;
    /** Set for a set recorded under an older policy whose wording could be misread; never a rewrite of the stored explanation. */
    readonly policyNote: string | null;
  } | null;
  readonly opportunities: readonly UncertaintyOpportunityView[];
  readonly counts: {
    readonly opportunities: number;
    readonly candidates: number;
    readonly rejected: number;
    readonly selected: number;
  };
  /** Rejected candidates by stable code (counts only: a refused question is not shown to a judge). */
  readonly rejections: readonly { readonly code: CandidateRejection; readonly count: number }[];
  readonly notices: {
    readonly advisory: string;
    readonly ranking: 'deterministic_ordering_not_a_probability';
    readonly scores: 'questions_never_change_scores';
  };
}

export interface QuestionSetSummary {
  readonly id: string;
  readonly assessmentId: string;
  readonly createdAt: string;
  readonly demonstration: boolean;
  readonly selected: number;
}

export interface QuestionSetListResponse {
  readonly projectId: string;
  readonly assessmentId: string;
  /** Newest first. */
  readonly sets: readonly QuestionSetSummary[];
  /** The assessment this list is about, and whether it verifies (a question set can be generated only for a verified one). */
  readonly assessmentVerified: boolean;
  readonly launch: {
    readonly available: boolean;
    readonly providerMode: ProviderMode | null;
    readonly notice: string;
  };
}

export type CreateQuestionSetResponse = {
  readonly result: 'created' | 'already_generated';
  readonly set: QuestionSetView;
};

export const QUESTION_ADVISORY_NOTICE =
  'Suggested questions for the human judge. They are prompts for the interview, not findings: the judge may ask different questions, and no question or answer changes any score.' as const;
export const QUESTION_DEMONSTRATION_NOTICE =
  'Offline demonstration, not AI-generated: these questions were produced by fixed rules (or replayed from a hand-written fixture) from the uncertainty analysis, not phrased by a model. The human judge may ask different questions, and no question changes any score.' as const;

export const CreateQuestionSetRequest = z.strictObject({});
export type CreateQuestionSetRequest = z.infer<typeof CreateQuestionSetRequest>;

export const QuestionSetParams = z.strictObject({ projectId: Uuid, assessmentId: Uuid });
