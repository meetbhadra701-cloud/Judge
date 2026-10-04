export {
  authorityRank,
  compareAuthorityDescending,
  SOURCE_AUTHORITY_PRECEDENCE,
} from './authority.js';
export { blankDocumentInput } from './blank.js';
export { resolveConflict, type ConflictResolutionResult } from './conflicts.js';
export {
  applyHumanEdit,
  documentFromExtraction,
  type DocumentChanges,
  type DocumentContext,
} from './document.js';
export {
  EVENT_CONTEXT_ISSUE_CODES,
  EVENT_CONTEXT_OPERATION_CODES,
  EventContextError,
  type EventContextErrorCode,
  type EventContextIssueCode,
  type TypedIssue,
} from './errors.js';
export {
  ExtractorUnavailableError,
  type EventContextExtractionInput,
  type EventContextExtractor,
  type ExtractorSource,
} from './extractor.js';
export { listFacts, type FactEntry } from './facts.js';
export { canonicalJson, normalizeSourceText, sha256Hex, sourceContentHash } from './hash.js';
export { collectSourceIds, remapSourceIds } from './references.js';
export {
  createReplayExtractor,
  ReplayRecording,
  type ReplayRecordingInput,
} from './replay-extractor.js';
export { lockedContentHash } from './snapshot.js';
export { listUnresolved } from './unresolved.js';
export {
  RUBRIC_WEIGHT_SUM_TOLERANCE,
  rubricWeightSumIssues,
  validateDocument,
  validateForLock,
  type VersionSources,
} from './validation.js';
