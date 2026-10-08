/*
 * @judge-copilot/scoring — the deterministic scoring engine (scoring-engine/v1, M4).
 *
 * Layer 2: pure TypeScript. No model, prompt, provider, network, filesystem, clock, randomness or
 * persistence. Weights, aggregation, evidence strength, coverage, confidence, states, versioning and
 * hashing are all code. Numeric parameters are transparent heuristics, not calibrated probabilities.
 *
 * Public entry points:
 *   createTrustedScoringContext  build the trusted in-process context (rubric, graph, tracks)
 *   scoreProject                 score untrusted assessor judgments against it
 *
 * There is intentionally NO exported way to supply trusted attestations, override a verification
 * level, set the weight of a verification level, or alter a published rubric.
 */
export { createTrustedScoringContext, isTrustedScoringContext } from './context.js';
export type {
  CreateTrustedScoringContextInput,
  ScoringGraphInput,
  TrustedScoringContext,
  TrustedScoringContextResult,
} from './context.js';
export { scoreProject } from './engine.js';
export type { ScoreResult } from './engine.js';
export { parametersHash } from './parameters-hash.js';
export { SCORING_PARAMETERS } from './parameters.js';
export { FALLBACK_RUBRIC_DEFINITION } from './rubric/fallback.js';
export { selectRubric } from './rubric/select.js';
export type { ScoringTarget, SelectRubricInput, SelectRubricResult } from './rubric/select.js';
export type { CriterionSpec, DimensionSpec, NeedGroup, RubricSpec } from './rubric/spec.js';
export { validatePublishedWeights } from './rubric/weights.js';
export type { WeightValidation } from './rubric/weights.js';
