import {
  parseStageOutput,
  type ClaimExtractionOutput,
  type ContradictionDetectionOutput,
  type CriticOutput,
  type DimensionAssessmentOutput,
  type EvidenceInterpretationOutput,
  type FidelityReviewOutput,
  type RelationMatchingOutput,
  type RelationVerificationOutput,
  type StageOutputIssue,
  type UnknownIdentificationOutput,
} from '@judge-copilot/schemas';
import {
  gateContradictions,
  gateUnknowns,
  type CommentaryWorld,
  type ProposedContradiction,
  type ProposedUnknown,
} from './commentary.js';
import type { ClosedSet } from './closed-set.js';
import { gateCritic, type CriticGateResult } from './critic.js';
import {
  gateClaims,
  gateEvidence,
  gateFidelityCall,
  type AdmittedClaim,
  type AdmittedEvidence,
  type ClaimGateState,
  type EvidenceGateState,
  type FidelityCallResult,
  type PendingReview,
  type GateOutcome,
  type PassageIndex,
} from './extraction.js';
import { gateJudgment, type JudgmentGateResult } from './judgment.js';
import type { UnitCandidates } from './candidates.js';
import {
  gateRelations,
  resolveVerification,
  type ProposedRelation,
  type RelationWorld,
  type VerificationPair,
  type VerificationResolution,
} from './relations.js';

/*
 * The two gates in order (invariant 19). Every function here takes the model's raw JSON, runs the strict P1 Zod schema FIRST
 * (shape), and only a schema-valid value reaches the domain gate. A shape failure carries Zod issue paths and codes only: never the
 * offending value, so it cannot echo model or project text into a repair prompt.
 */

export interface ShapeFailure {
  readonly ok: false;
  readonly phase: 'shape';
  readonly issues: readonly StageOutputIssue[];
}

export type Staged<T> = ShapeFailure | ({ readonly ok: true; readonly phase: 'domain' } & T);

function through<T>(
  stage: Parameters<typeof parseStageOutput>[0],
  json: unknown,
  gate: (value: never) => T,
): Staged<T> {
  const shaped = parseStageOutput(stage, json);
  if (!shaped.ok) return { ok: false, phase: 'shape', issues: shaped.issues };
  // `shaped.value` has just passed the stage's strict schema; each caller's gate takes exactly that stage's output type.
  return { ok: true, phase: 'domain', ...gate(shaped.value as never) };
}

/*
 * Every wrapper takes the CLOSED SET of the call being validated (`RenderedPrompt.closedSet`, or the subset it needs) as a REQUIRED
 * argument. Passing the world the output is checked against is not enough: see closed-set.ts.
 */

export const validateClaimExtraction = (
  json: unknown,
  passages: PassageIndex,
  shown: Pick<ClosedSet, 'passages'>,
  state?: ClaimGateState,
) =>
  through<GateOutcome<AdmittedClaim>>('claim_extraction', json, (value: ClaimExtractionOutput) =>
    gateClaims(value, passages, shown, state),
  );

export const validateEvidenceInterpretation = (
  json: unknown,
  passages: PassageIndex,
  shown: Pick<ClosedSet, 'passages'>,
  state?: EvidenceGateState,
) =>
  through<GateOutcome<AdmittedEvidence>>(
    'evidence_interpretation',
    json,
    (value: EvidenceInterpretationOutput) => gateEvidence(value, passages, shown, state),
  );

/** One fidelity-review call (a batch). Combine the calls' `call` values with `resolveFidelity`. */
export const validateFidelityReview = (
  json: unknown,
  shown: Pick<ClosedSet, 'items'>,
  pending: readonly PendingReview[],
) =>
  through<FidelityCallResult>('fidelity_review', json, (value: FidelityReviewOutput) =>
    gateFidelityCall(value, shown, pending),
  );

export const validateRelationMatching = (
  json: unknown,
  world: RelationWorld,
  shown: Pick<ClosedSet, 'claims' | 'evidence'>,
  existing?: readonly ProposedRelation[],
) =>
  through<GateOutcome<ProposedRelation>>(
    'relation_matching',
    json,
    (value: RelationMatchingOutput) => gateRelations(value, world, shown, existing),
  );

/** One verifier call. Combine the calls with `combineVerifications`. */
export const validateRelationVerification = (
  json: unknown,
  pairs: readonly VerificationPair[],
  shown: Pick<ClosedSet, 'pairs'>,
) =>
  through<VerificationResolution>(
    'relation_verification',
    json,
    (value: RelationVerificationOutput) => resolveVerification(pairs, value, shown),
  );

export const validateContradictions = (
  json: unknown,
  world: CommentaryWorld,
  shown: Pick<ClosedSet, 'claims' | 'evidence'>,
  existing?: readonly ProposedContradiction[],
) =>
  through<GateOutcome<ProposedContradiction>>(
    'contradiction_detection',
    json,
    (value: ContradictionDetectionOutput) => gateContradictions(value, world, shown, existing),
  );

export const validateUnknowns = (
  json: unknown,
  world: CommentaryWorld,
  shown: Pick<ClosedSet, 'claims' | 'evidence'>,
  existing?: readonly ProposedUnknown[],
) =>
  through<GateOutcome<ProposedUnknown>>(
    'unknown_identification',
    json,
    (value: UnknownIdentificationOutput) => gateUnknowns(value, world, shown, existing),
  );

export type StagedJudgment = ShapeFailure | ({ readonly phase: 'domain' } & JudgmentGateResult);
export function validateDimensionAssessment(
  json: unknown,
  unit: UnitCandidates,
  scale: { readonly min: number; readonly max: number },
  shown: Pick<ClosedSet, 'evidence' | 'unit'>,
): StagedJudgment {
  const shaped = parseStageOutput('dimension_assessment', json);
  if (!shaped.ok) return { ok: false, phase: 'shape', issues: shaped.issues };
  return {
    phase: 'domain',
    ...gateJudgment(shaped.value as DimensionAssessmentOutput, unit, scale, shown),
  };
}

export type StagedCritic = ShapeFailure | ({ readonly phase: 'domain' } & CriticGateResult);
export function validateCritic(
  json: unknown,
  shown: Pick<ClosedSet, 'evidence' | 'unit'>,
): StagedCritic {
  const shaped = parseStageOutput('critic', json);
  if (!shaped.ok) return { ok: false, phase: 'shape', issues: shaped.issues };
  return { phase: 'domain', ...gateCritic(shaped.value as CriticOutput, shown) };
}
