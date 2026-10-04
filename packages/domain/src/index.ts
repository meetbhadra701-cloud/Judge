/*
 * @judge-copilot/domain — the vocabulary every other package speaks.
 *
 * Domain types are inferred from the Zod schemas in @judge-copilot/schemas and re-exported
 * here, so there is exactly one definition of each concept. Business packages (evidence,
 * scoring, uncertainty, questions, ...) import domain concepts from this package.
 *
 * This package is pure: no I/O, no environment access, no model calls, no database.
 */
export type {
  ActorRole,
  AnalysisRunFailureCategory,
  AnalysisRunState,
  AssessmentKind,
  CaptureFailureCategory,
  EventContextStatus,
  EvidenceKind,
  EvidenceOrigin,
  ProjectSourceType,
  QuestionMode,
  Ratio,
  Score10,
  SourceSnapshotStatus,
  UnknownType,
  VerificationLevel,
} from '@judge-copilot/schemas';

export * from './lifecycle.js';
export * from './authorization.js';
