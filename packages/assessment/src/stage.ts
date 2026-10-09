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
import { gateCritic, type CriticGateResult } from './critic.js';
import {
  gateClaims,
  gateEvidence,
  resolveFidelity,
  type AdmittedClaim,
  type AdmittedEvidence,
  type ClaimGateState,
  type EvidenceGateState,
  type FidelityResolution,
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

export const validateClaimExtraction = (
  json: unknown,
  passages: PassageIndex,
  state?: ClaimGateState,
) =>
  through<GateOutcome<AdmittedClaim>>('claim_extraction', json, (value: ClaimExtractionOutput) =>
    gateClaims(value, passages, state),
  );

export const validateEvidenceInterpretation = (
  json: unknown,
  passages: PassageIndex,
  state?: EvidenceGateState,
) =>
  through<GateOutcome<AdmittedEvidence>>(
    'evidence_interpretation',
    json,
    (value: EvidenceInterpretationOutput) => gateEvidence(value, passages, state),
  );

export const validateFidelityReview = (
  json: unknown,
  claims: readonly AdmittedClaim[],
  evidence: readonly AdmittedEvidence[],
) =>
  through<FidelityResolution>('fidelity_review', json, (value: FidelityReviewOutput) =>
    resolveFidelity(claims, evidence, value.verdicts),
  );

export const validateRelationMatching = (
  json: unknown,
  world: RelationWorld,
  existing?: readonly ProposedRelation[],
) =>
  through<GateOutcome<ProposedRelation>>(
    'relation_matching',
    json,
    (value: RelationMatchingOutput) => gateRelations(value, world, existing),
  );

export const validateRelationVerification = (json: unknown, pairs: readonly VerificationPair[]) =>
  through<VerificationResolution>(
    'relation_verification',
    json,
    (value: RelationVerificationOutput) => resolveVerification(pairs, value),
  );

export const validateContradictions = (
  json: unknown,
  world: CommentaryWorld,
  existing?: readonly ProposedContradiction[],
) =>
  through<GateOutcome<ProposedContradiction>>(
    'contradiction_detection',
    json,
    (value: ContradictionDetectionOutput) => gateContradictions(value, world, existing),
  );

export const validateUnknowns = (
  json: unknown,
  world: CommentaryWorld,
  existing?: readonly ProposedUnknown[],
) =>
  through<GateOutcome<ProposedUnknown>>(
    'unknown_identification',
    json,
    (value: UnknownIdentificationOutput) => gateUnknowns(value, world, existing),
  );

export type StagedJudgment = ShapeFailure | ({ readonly phase: 'domain' } & JudgmentGateResult);
export function validateDimensionAssessment(
  json: unknown,
  unit: UnitCandidates,
  scale: { readonly min: number; readonly max: number },
): StagedJudgment {
  const shaped = parseStageOutput('dimension_assessment', json);
  if (!shaped.ok) return { ok: false, phase: 'shape', issues: shaped.issues };
  return {
    phase: 'domain',
    ...gateJudgment(shaped.value as DimensionAssessmentOutput, unit, scale),
  };
}

export type StagedCritic = ShapeFailure | ({ readonly phase: 'domain' } & CriticGateResult);
export function validateCritic(
  json: unknown,
  unit: string,
  shown: ReadonlySet<string>,
): StagedCritic {
  const shaped = parseStageOutput('critic', json);
  if (!shaped.ok) return { ok: false, phase: 'shape', issues: shaped.issues };
  return { phase: 'domain', ...gateCritic(shaped.value as CriticOutput, unit, shown) };
}
