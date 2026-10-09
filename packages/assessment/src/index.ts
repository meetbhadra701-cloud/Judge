/*
 * @judge-copilot/assessment — the trust boundary between model-produced JSON and the authoritative evidence graph and the scoring
 * engine (M5, phase P3).
 *
 * Layer 2 (deterministic core): pure TypeScript. No model, prompt, provider, network, filesystem, clock, randomness, database or
 * persistence. It imports no `llm`, `prompts`, `database` or worker code; the P5 orchestrator wires those around it.
 *
 * Every model output has already passed its strict Zod schema (gate 1) before it reaches a function here (gate 2, the domain gates
 * G1-G7). Gates REJECT; they never repair. Models refer to records only through code-assigned handles; this package maps handles to
 * ids, derives every span, excerpt, origin and verification label itself, and returns issues that carry codes and paths, never text.
 */
export {
  buildCandidateSets,
  channelOfEvidence,
  preGate,
  requiredReferenceKinds,
  TRACK_ELIGIBILITY_DIMENSION,
  withoutCandidates,
  CANDIDATE_POLICY,
  CANDIDATES_PER_UNIT,
  EVENT_REFERENCES_PER_UNIT,
  FALLBACK_TRACK_PREFIX,
  PRE_GATE_REASON_VALUES,
} from './candidates.js';
export type {
  Authorship,
  CandidateInputs,
  CandidateItem,
  PreGateReason,
  UnitCandidates,
} from './candidates.js';
export { ClosedSetRequiredError } from './closed-set.js';
export type { ClosedSet } from './closed-set.js';
export { containsAccusation } from './neutral.js';
export { decideAfterCritic, gateCritic, RERUN_CAPS } from './critic.js';
export type {
  CriticDecision,
  CriticDecisionInput,
  CriticFinding,
  CriticGateResult,
  RerunFeedback,
  RubricKind,
} from './critic.js';
export {
  buildEventReferenceItems,
  EVENT_REFERENCE_BUILDER,
  referenceMetaByEvidenceId,
  referenceMetaOf,
  REFERENCE_APPLICABILITY_VALUES,
} from './event-evidence.js';
export type {
  EventReferenceApplicability,
  EventReferenceExclusion,
  EventReferenceItem,
  EventReferenceKind,
  EventReferenceMeta,
  EventReferenceResult,
} from './event-evidence.js';
export {
  gateClaims,
  gateEvidence,
  gateFidelityCall,
  indexPassages,
  MAX_CLAIMS_PER_RUN,
  MAX_EVIDENCE_PER_RUN,
  pendingReviews,
  resolveFidelity,
  FIDELITY_DISPOSITION_VALUES,
} from './extraction.js';
export type {
  AdmittedClaim,
  AdmittedEvidence,
  ClaimGateState,
  EvidenceGateState,
  FidelityCall,
  FidelityCallResult,
  FidelityDisposition,
  FidelityResolution,
  GateOutcome,
  Grounding,
  PassageIndex,
  PendingReview,
} from './extraction.js';
export {
  assembleContextBatch,
  assembleExtractionBatch,
  buildPlanContext,
  dryRunPlan,
  membersHash,
  membersOf,
  recordsFromPlan,
  scopeGraph,
  verifyClosure,
} from './graph.js';
export type {
  AssembledBatch,
  BatchInput,
  ExtractionMembers,
  ExtractionRecords,
  PlanWorld,
  RelationBasisRecord,
  ScopeResult,
  VerifiedScopeInput,
  SnapshotFact,
} from './graph.js';
export { claimHandle, evidenceHandle, pairHandle } from './handles.js';
export { GATE_VALUES } from './issues.js';
export type { DomainIssue, GateId, Rejection } from './issues.js';
export {
  applyPostGates,
  buildAssessorJudgments,
  classifyDisposition,
  CRITIC_FLAG_CODES,
  deterministicFlags,
  gateJudgment,
  preGated,
  UNIT_DISPOSITION_VALUES,
} from './judgment.js';
export type {
  CriticFlag,
  DispositionClass,
  FinalUnit,
  JudgmentGateResult,
  UnitDisposition,
  ValidatedCitation,
  ValidatedJudgment,
} from './judgment.js';
export {
  EMITTABLE_LEVELS,
  LABEL_POLICY_ID,
  kindForEvidence,
  levelForClaim,
  levelForEvidence,
  originForEvidence,
} from './label-policy.js';
export {
  locateQuote,
  QUOTE_FAILURE_CODES,
  QUOTE_MAX_CODE_POINTS,
  QUOTE_MIN_CODE_POINTS,
} from './quote.js';
export type { LocatedQuote, LocateResult, QuoteFailureCode } from './quote.js';
export {
  gateContradictions,
  gateUnknowns,
  MAX_CONTRADICTIONS_PER_RUN,
  MAX_UNKNOWNS_PER_RUN,
} from './commentary.js';
export type { CommentaryWorld, ProposedContradiction, ProposedUnknown } from './commentary.js';
export {
  combineVerifications,
  gateRelations,
  pairsForVerification,
  resolveVerification,
  MAX_RELATIONS_PER_CLAIM,
  MAX_RELATIONS_PER_RUN,
  RELATION_DROP_REASON_VALUES,
} from './relations.js';
export type {
  DroppedRelation,
  ProposedRelation,
  RelationBasis,
  RelationClaim,
  RelationEvidence,
  RelationWorld,
  VerificationPair,
  VerificationResolution,
} from './relations.js';
export { evaluateRun, technicalThreshold } from './run-policy.js';
export type { RunEvaluation } from './run-policy.js';
export {
  routeArtifact,
  SKIP_REASON_VALUES,
  SOURCE_ROUTING_POLICY,
  SOURCE_TYPE_VALUES,
} from './routing.js';
export type {
  ArtifactDescriptor,
  Bucket,
  InterpretClass,
  RoutedSourceType,
  RouteDecision,
  SkipReason,
} from './routing.js';
export { sourceGapUnknowns, SOURCE_STATUS_VALUES } from './source-gaps.js';
export type { CodeUnknown, SourceGapStatus, SourceStatus } from './source-gaps.js';
export {
  validateClaimExtraction,
  validateContradictions,
  validateCritic,
  validateDimensionAssessment,
  validateEvidenceInterpretation,
  validateFidelityReview,
  validateRelationMatching,
  validateRelationVerification,
  validateUnknowns,
} from './stage.js';
export type { ShapeFailure, Staged, StagedCritic, StagedJudgment } from './stage.js';
export { buildStatementItems } from './statements.js';
export type { StatementItem, StatementResult } from './statements.js';
export { STORED_REPORT_CHECKS, storedFormOf, verifyStoredAssessment } from './verify-report.js';
export type {
  StoredAssessmentReport,
  StoredReportCheck,
  StoredReportVerification,
} from './verify-report.js';
export {
  artifactLabel,
  buildPassages,
  compareCodePoints,
  DEFAULT_BUDGETS,
  interpretViews,
  OMISSION_REASON_VALUES,
  PASSAGE_MAX_CODE_POINTS,
  passageRanges,
  SELECTION_POLICY,
  statementViews,
  WINDOWING_POLICY,
} from './windowing.js';
export type {
  BucketUse,
  InterpretPassageView,
  Omission,
  OmissionReason,
  Passage,
  SourceArtifact,
  StatementPassageView,
  WindowingBudgets,
  WindowingResult,
} from './windowing.js';
export {
  collectLimitations,
  EXTRACTION_LIMITATION_CODES,
  unassessedTrackRubrics,
} from './limitations.js';
export type { ExtractionLimitationCode, Limitation, LimitationInputs } from './limitations.js';
