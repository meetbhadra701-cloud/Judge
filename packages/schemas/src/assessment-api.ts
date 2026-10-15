import { z } from 'zod';
import type { AssessmentCoverageSummary, AssessmentCoverageView } from './coverage.js';
import type { ProviderMode } from './assessment.js';
import type { SourceSnapshotStatus, UnknownType } from './enums.js';
import { AssessmentRequestMode } from './assessment.js';
import { Uuid } from './primitives.js';
import type { ScoreReport } from './scoring.js';

/*
 * The HTTP contract of the pre-interview assessment (M5 P6A, design §10.2). Timestamps are ISO-8601 UTC strings.
 *
 * Everything here is an AI ESTIMATE for the human judge, never the judge's score. A dimension without enough evidence has NO number
 * of any kind (`score` is null and the report's `insufficient_evidence` state has no score field); a failed or cancelled run has no
 * assessment at all.
 *
 * VERIFIED OR WITHHELD (P6A-R1). Every read re-verifies the stored assessment in two steps: the report bytes (text hash, schema, M4
 * output hash, canonical fixed point, jsonb mirror), then the judgment rows against that report (same dimensions, same state, the same number AT THE REPORT'S
 * CANONICAL PRECISION, same cited evidence ids). If either step fails the assessment is `verified: false` and ONLY safe metadata is returned: `report` is
 * null, `judgments` and `limitations` are empty, and no score, rationale, citation or evidence text of any kind appears; in the list
 * `overall` is null. `verificationFailure` carries a stable machine code (a report check name, `report_schema`, or
 * `judgment_mismatch_<reason>`). The verifier authenticates the report and the agreement of the rows with it; it does NOT authenticate
 * the free text of a verified assessment's rows (rationale, citation notes, limitation codes; `notices.storedText` says so), which no hash covers, and its hashes live
 * in the same database as the data (they detect inconsistent edits and corruption, not a writer able to recompute every column).
 *
 * CANONICAL SCORE PRECISION (P6A-R2). Every number the API returns for a judgment comes from the verified report, where M4 rounded it ONCE,
 * half-up, to four decimals on the decimal the raw score prints as (negative zero becomes zero). The raw value the assessor gave is not
 * returned: an assessor's 7.33333 is reported, and verified, as 7.3333, and two raw values in the same four-decimal bucket are
 * indistinguishable to the verifier. A dimension whose judged value M4 declined to use (`insufficiencyReason: 'no_usable_citation'`:
 * only absence/unknown/contradiction evidence was cited) has no number at all (the verified report's own diagnostic says the value was not used). `notices.semanticRelevance` is always `not_verified` (the scorer does not check that a citation is relevant).
 */

export const ASSESSMENT_API_NOTICE =
  'AI estimate from the submitted material only. The human judge’s final score is separate and authoritative.' as const;

/** Body of `POST /projects/:projectId/assessments`. */
export const CreateAssessmentRequest = z.strictObject({ mode: AssessmentRequestMode });
export type CreateAssessmentRequest = z.infer<typeof CreateAssessmentRequest>;

/** `Idempotency-Key` header: a UUID (design §8.6). */
export const IdempotencyKey = Uuid;

export const ASSESSMENT_RUN_STATE_VALUES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export const AssessmentRunState = z.enum(ASSESSMENT_RUN_STATE_VALUES);
export type AssessmentRunState = z.infer<typeof AssessmentRunState>;

/**
 * WHO decided that a dimension has no number (R6A). Never "valid": no label here says that a model's claim of insufficiency is
 * correct, only who made it. `insufficient_by_assessor` is the model's own claim and was not independently reviewed.
 */
export const DISPOSITION_ATTRIBUTION_VALUES = [
  'scored',
  'insufficient_by_assessor',
  'insufficient_by_code',
  'insufficient_by_critic',
  'technical',
] as const;
export type DispositionAttribution = (typeof DISPOSITION_ATTRIBUTION_VALUES)[number];

export interface AssessmentUsageView {
  readonly attemptsStarted: number;
  readonly settledCalls: number;
  readonly unknownCalls: number;
  readonly releasedCalls: number;
  /** Counted tokens and cost (a settled call at its measured usage, an ambiguous call at its worst case; a released call at zero). */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costNanoUsd: number;
}

/** The configured LOCAL spending guard of a run: a software limit of this application, not a provider billing limit. */
export interface AssessmentGuardView {
  readonly maxCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxCostNanoUsd: number;
  readonly maxReservedInputTokensPerCall: number;
  readonly runWallClockMs: number;
  readonly priceTableId: string;
  readonly notice: 'local_spending_guard_not_a_provider_billing_limit';
}

export interface AssessmentRunView {
  readonly id: string;
  readonly projectId: string;
  readonly state: AssessmentRunState;
  readonly mode: AssessmentRequestMode | null;
  /** Machine category of a failed run (null otherwise). */
  readonly failureCategory: string | null;
  /** Machine code of the end of a failed or cancelled run, from the run outcome (null otherwise). */
  readonly failureCode: string | null;
  readonly stageReached: string | null;
  /** The provider mode the run was requested for, from its frozen pipeline configuration. */
  readonly providerMode: ProviderMode | null;
  readonly replayDemonstration: boolean;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** Set only when the run succeeded. */
  readonly assessmentId: string | null;
  readonly usage: AssessmentUsageView;
  readonly guard: AssessmentGuardView;
  /** What the run's source selection did (a run refused at the coverage gate still has one). `not_recorded` for runs from before coverage records. */
  readonly coverage: AssessmentCoverageSummary;
}

export interface AssessmentOverallSummary {
  readonly state: string;
  /** null unless the overall is a computed score; never filled in for an insufficient or not-computed overall. */
  readonly score10: number | null;
}

export interface AssessmentSummary {
  readonly id: string;
  readonly versionNumber: number;
  readonly runId: string;
  readonly createdAt: string;
  readonly providerMode: ProviderMode;
  readonly replayDemonstration: boolean;
  readonly target: 'overall';
  readonly overall: AssessmentOverallSummary | null;
  readonly verified: boolean;
  /** A scored headline never travels without this: `all dimensions scored` is not `all evidence examined`. */
  readonly coverage: AssessmentCoverageSummary;
}

/** What the "Run" action may do right now (from the configured offline runtime gate). */
export interface AssessmentLaunchView {
  readonly available: boolean;
  readonly providerMode: ProviderMode | null;
  /** Always states whether any project text leaves this system. */
  readonly notice: string;
}

export interface AssessmentListResponse {
  /** Newest version first. */
  readonly assessments: readonly AssessmentSummary[];
  readonly activeRun: AssessmentRunView | null;
  /** The most recent assessment run of any state (so a failed or cancelled run is visible when there is no assessment). */
  readonly latestRun: AssessmentRunView | null;
  readonly launch: AssessmentLaunchView;
  readonly notice: typeof ASSESSMENT_API_NOTICE;
}

export interface CitedEvidenceView {
  readonly kind: string;
  readonly origin: string;
  /** The evidence label as recorded (for example `team_claim`, `unverified`): never proof of truth. */
  readonly verificationLevel: string;
  readonly text: string;
  readonly excerpt: string | null;
  readonly snapshotId: string | null;
  readonly artifactId: string | null;
  readonly span: { readonly start: number; readonly end: number } | null;
  readonly contextVersionId: string | null;
}

export interface JudgmentCitationView {
  readonly evidenceId: string;
  readonly directness: string;
  readonly specificity: string;
  readonly note: string;
  readonly evidence: CitedEvidenceView | null;
}

export interface AssessmentJudgmentView {
  readonly dimensionId: string;
  readonly position: number;
  readonly outcomeKind: 'scored' | 'insufficient_evidence';
  /**
   * The assessor's rating on the rubric scale AS THE VERIFIED REPORT STATES IT: rounded once, half-up, to four decimals (the report's
   * canonical precision), so 7.33333 is shown as 7.3333. Null for every insufficient outcome (never zero-filled), including a dimension
   * whose judged value M4 declined to use (`insufficiencyReason: 'no_usable_citation'`): that raw value is never returned as a judgment score (the verified report's own `JUDGED_VALUE_NOT_USED` diagnostic may state it).
   */
  readonly score: number | null;
  /** Why a dimension has no number, from the verified report (null when it has one). */
  readonly insufficiencyReason: 'assessor_reported_insufficient' | 'no_usable_citation' | null;
  readonly disposition: string;
  /** Who decided the outcome (see `DispositionAttribution`). */
  readonly dispositionAttribution: DispositionAttribution;
  readonly rationale: string | null;
  readonly limitations: readonly string[];
  readonly assessorAttempts: number;
  readonly criticAttempts: number;
  readonly criticReviewRequired: boolean;
  readonly criticReviewed: boolean;
  readonly semanticRelevance: 'not_verified';
  readonly citations: readonly JudgmentCitationView[];
}

export interface AssessmentLimitationView {
  readonly code: string;
  readonly count: number;
  readonly subjects: readonly string[];
}

export interface AssessmentDetail {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string;
  readonly versionNumber: number;
  readonly createdAt: string;
  readonly providerMode: ProviderMode;
  readonly replayDemonstration: boolean;
  readonly target: 'overall';
  /** The stored assessment re-verified in two steps (see the header). When false NO content is returned. */
  readonly verified: boolean;
  readonly verificationFailure: string | null;
  readonly report: ScoreReport | null;
  readonly judgments: readonly AssessmentJudgmentView[];
  readonly limitations: readonly AssessmentLimitationView[];
  readonly coverage: AssessmentCoverageView;
  readonly pipeline: {
    readonly provider: { readonly id: string; readonly mode: ProviderMode };
    readonly models: {
      readonly extraction: string;
      readonly assessment: string;
      readonly critic: string;
    };
    readonly configHash: string;
  } | null;
  readonly usage: AssessmentUsageView;
  readonly notices: {
    readonly advisory: typeof ASSESSMENT_API_NOTICE;
    readonly semanticRelevance: 'not_verified';
    /**
     * `rationale`, citation `note`s, per-judgment `limitations`, attempt counts, critic flags, the `disposition` and its attribution, and the
     * assessment-level `limitations` are text/metadata stored in separate rows. They are returned only for an assessment that verified and
     * whose rows agree with the report on numbers, state and citations, but no hash covers THEM: they are not cryptographically authenticated.
     */
    readonly storedText: 'not_hash_covered';
    readonly target: 'overall_rubric_only';
    readonly replay: string | null;
  };
}

/** The answer of `POST /projects/:projectId/assessments`. */
export type CreateAssessmentResponse =
  | {
      readonly result: 'run_created' | 'run_active';
      readonly runId: string;
      readonly state: 'pending' | 'running';
      readonly replayed: boolean;
    }
  | {
      readonly result: 'assessment_ready' | 'already_assessed';
      readonly assessmentId: string;
      readonly runId: string | null;
      readonly replayed: boolean;
    }
  | {
      readonly result: 'run_failed';
      readonly runId: string;
      readonly state: 'failed' | 'cancelled';
      readonly failureCategory: string | null;
      readonly replayed: true;
    };

/**
 * One unknown (a recorded gap in what the project material shows) that belongs to ONE assessment: a member of the graph extraction that
 * assessment was scored from. Unknowns that were recorded for the same type and text are shown once, with how many times.
 */
export interface AssessmentUnknownView {
  readonly id: string;
  readonly seq: number;
  readonly unknownType: UnknownType;
  readonly text: string;
  readonly claimIds: readonly string[];
  readonly evidenceIds: readonly string[];
  /** How many identical records (same type and text) the extraction holds; 1 when it is unique. */
  readonly occurrences: number;
}

/** A source that has a capture newer than the one this assessment was scored from. */
export interface NewerCaptureView {
  readonly sourceId: string;
  readonly sourceType: string;
  /** The capture number this assessment used for the source, or null when it used none of that source. */
  readonly pinnedCaptureNumber: number | null;
  readonly newerCaptureNumber: number;
  readonly newerStatus: SourceSnapshotStatus;
  readonly newerAt: string;
}

/**
 * `GET /projects/:projectId/assessments/:assessmentId/unknowns`. SCOPE: the unknowns of that assessment's own pinned graph extraction
 * (immutable membership), never the project's later or earlier ones. It describes the material the assessment was scored from, NOT the
 * project's current gaps: `currency` says whether newer captures exist since, in which case a new assessment is needed to learn what is
 * still unknown. An assessment that does not verify returns no items (the same fail-closed rule as the report).
 */
export interface AssessmentUnknownsResponse {
  readonly assessmentId: string;
  readonly versionNumber: number;
  readonly verified: boolean;
  readonly scope: 'assessment_pinned_extraction';
  readonly items: readonly AssessmentUnknownView[];
  /** null for an assessment that does not verify. */
  readonly currency: {
    readonly upToDate: boolean;
    readonly newerCaptures: readonly NewerCaptureView[];
  } | null;
  readonly notice: string;
}

export const ASSESSMENT_UNKNOWNS_NOTICE =
  'These unknowns were recorded for the material this assessment was scored from. They are not a list of the project’s current gaps: a capture made since may have resolved or changed them.';
