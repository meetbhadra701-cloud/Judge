import { z } from 'zod';

/*
 * Foundational vocabularies of the Judge Copilot domain.
 *
 * Each vocabulary is exported twice:
 *   - as a readonly tuple of values (`*_VALUES`), so other layers (e.g. database CHECK
 *     constraints) are generated from the same source and cannot drift;
 *   - as a Zod schema with an inferred type of the same name.
 *
 * Meanings are specified in docs/ARCHITECTURE.md and docs/SCORING.md. Changing a value
 * here is an architecture change, not a refactor.
 */

/**
 * How strongly a piece of evidence has been established.
 * A team statement stays `team_claim` until corroborated or verified (invariant 4).
 */
export const VERIFICATION_LEVEL_VALUES = [
  'unverified',
  'team_claim',
  'repo_corroborated',
  'machine_verified',
  'judge_verified',
  'live_verified',
  'contradicted',
] as const;
export const VerificationLevel = z.enum(VERIFICATION_LEVEL_VALUES);
export type VerificationLevel = z.infer<typeof VerificationLevel>;

/**
 * The epistemic kind of an evidence item. `absence` records that something was looked for
 * and not found; `unknown` records that it could not be determined. Neither is negative
 * evidence about quality (invariant 3).
 */
export const EVIDENCE_KIND_VALUES = [
  'fact',
  'claim',
  'absence',
  'unknown',
  'contradiction',
] as const;
export const EvidenceKind = z.enum(EVIDENCE_KIND_VALUES);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

/** Where an evidence item came from. Everything except `event_context` and `judge_observation` is project-supplied, untrusted data. */
export const EVIDENCE_ORIGIN_VALUES = [
  'event_context',
  'devpost',
  'github',
  'deployment',
  'video',
  'team_answer',
  'judge_observation',
] as const;
export const EvidenceOrigin = z.enum(EVIDENCE_ORIGIN_VALUES);
export type EvidenceOrigin = z.infer<typeof EvidenceOrigin>;

/** How a judge question is meant to be resolved during the interview. */
export const QUESTION_MODE_VALUES = ['ask', 'clarify', 'show_me', 'demonstrate', 'verify'] as const;
export const QuestionMode = z.enum(QUESTION_MODE_VALUES);
export type QuestionMode = z.infer<typeof QuestionMode>;

/** Why something relevant to the assessment is not known. */
export const UNKNOWN_TYPE_VALUES = [
  'missing',
  'ambiguous',
  'contradictory',
  'unverifiable',
  'subjective',
  'eligibility',
] as const;
export const UnknownType = z.enum(UNKNOWN_TYPE_VALUES);
export type UnknownType = z.infer<typeof UnknownType>;

/**
 * The two AI assessment versions. They are distinct immutable versions (invariant 10).
 * The human judge's final score is deliberately NOT an assessment kind: it is a separate,
 * authoritative record (invariant 15).
 */
export const ASSESSMENT_KIND_VALUES = ['pre_interview', 'post_interview'] as const;
export const AssessmentKind = z.enum(ASSESSMENT_KIND_VALUES);
export type AssessmentKind = z.infer<typeof AssessmentKind>;

/**
 * Lifecycle of an immutable source snapshot (Devpost page, repository tree, deployment, video).
 * `pending` is the only non-terminal state. `rejected` means source validation refused to
 * fetch it (e.g. a disallowed URL); `failed` means fetching was attempted and did not succeed.
 */
export const SOURCE_SNAPSHOT_STATUS_VALUES = [
  'pending',
  'captured',
  'partial',
  'failed',
  'rejected',
] as const;
export const SourceSnapshotStatus = z.enum(SOURCE_SNAPSHOT_STATUS_VALUES);
export type SourceSnapshotStatus = z.infer<typeof SourceSnapshotStatus>;

/**
 * Lifecycle of an Event Context version.
 *   draft      — being assembled / AI-extracted, not yet reviewed.
 *   in_review  — awaiting human review.
 *   locked     — human-reviewed and frozen; the only status usable for official assessment (invariant 18).
 *   superseded — was locked, has been replaced by a newer locked version; still frozen and
 *                still referenced by assessments made against it.
 */
export const EVENT_CONTEXT_STATUS_VALUES = ['draft', 'in_review', 'locked', 'superseded'] as const;
export const EventContextStatus = z.enum(EVENT_CONTEXT_STATUS_VALUES);
export type EventContextStatus = z.infer<typeof EventContextStatus>;

/**
 * Lifecycle of an analysis run (a unit of pipeline work such as an assessment).
 *   pending   — queued durable work that no worker has claimed yet (M2 source captures).
 *   running   — claimed and executing.
 *   succeeded / failed / cancelled — terminal.
 */
export const ANALYSIS_RUN_STATE_VALUES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export const AnalysisRunState = z.enum(ANALYSIS_RUN_STATE_VALUES);
export type AnalysisRunState = z.infer<typeof AnalysisRunState>;

/**
 * Why an analysis run failed. A failed run never produces a score (invariant 22).
 * "Evidence is insufficient" is NOT a failure: it is a legitimate assessment outcome (invariant 14).
 */
export const ANALYSIS_RUN_FAILURE_CATEGORY_VALUES = [
  'provider_error',
  'schema_validation_failed',
  'domain_validation_failed',
  'source_unavailable',
  'timeout',
  'internal_error',
  /** Assessment runs only (a CHECK ties it to `pre_interview_assessment`): the local spending guard stopped the run. */
  'budget_exceeded',
] as const;
export const AnalysisRunFailureCategory = z.enum(ANALYSIS_RUN_FAILURE_CATEGORY_VALUES);
export type AnalysisRunFailureCategory = z.infer<typeof AnalysisRunFailureCategory>;
