/*
 * Test-only convenience wrappers for the SINGLE-CALL case: the prompt of that call showed every record of the world it is validated
 * against, so the closed set handed to the gate is exactly that world. They pass an explicit, exact closed set (never omit it), which
 * is what the renderer's `closedSet` is for such a request. Tests of the cross-batch and cross-unit behavior call `../stage.js`
 * directly with a deliberately narrower closed set.
 */
import {
  type ClaimGateState,
  type CommentaryWorld,
  type EvidenceGateState,
  type PassageIndex,
  type ProposedContradiction,
  type ProposedRelation,
  type ProposedUnknown,
  type RelationWorld,
  type UnitCandidates,
  type VerificationPair,
} from '../index.js';
import * as stage from '../stage.js';

const routeHandles = (index: PassageIndex, route: 'statement' | 'interpret'): string[] =>
  [...index.values()].filter((passage) => passage.route === route).map((passage) => passage.handle);

export const validateClaimExtraction = (
  json: unknown,
  index: PassageIndex,
  state?: ClaimGateState,
) =>
  stage.validateClaimExtraction(json, index, { passages: routeHandles(index, 'statement') }, state);

export const validateEvidenceInterpretation = (
  json: unknown,
  index: PassageIndex,
  state?: EvidenceGateState,
) =>
  stage.validateEvidenceInterpretation(
    json,
    index,
    { passages: routeHandles(index, 'interpret') },
    state,
  );

export const validateRelationMatching = (
  json: unknown,
  world: RelationWorld,
  existing?: readonly ProposedRelation[],
) =>
  stage.validateRelationMatching(
    json,
    world,
    { claims: [...world.claims.keys()], evidence: [...world.evidence.keys()] },
    existing,
  );

export const validateRelationVerification = (json: unknown, pairs: readonly VerificationPair[]) =>
  stage.validateRelationVerification(json, pairs, { pairs: pairs.map((pair) => pair.handle) });

export const validateContradictions = (
  json: unknown,
  world: CommentaryWorld,
  existing?: readonly ProposedContradiction[],
) =>
  stage.validateContradictions(
    json,
    world,
    { claims: [...world.claims], evidence: [...world.evidence] },
    existing,
  );

export const validateUnknowns = (
  json: unknown,
  world: CommentaryWorld,
  existing?: readonly ProposedUnknown[],
) =>
  stage.validateUnknowns(
    json,
    world,
    { claims: [...world.claims], evidence: [...world.evidence] },
    existing,
  );

/** What the dimension-assessment prompt shows for a unit: every candidate handle and the unit id. */
export const closedSetOfUnit = (unit: UnitCandidates) => ({
  evidence: unit.items.map((item) => item.handle),
  unit: unit.dimensionId,
});

export const validateDimensionAssessment = (
  json: unknown,
  unit: UnitCandidates,
  scale: { readonly min: number; readonly max: number },
) => stage.validateDimensionAssessment(json, unit, scale, closedSetOfUnit(unit));

export const validateCritic = (json: unknown, unit: string, shown: ReadonlySet<string>) =>
  stage.validateCritic(json, { unit, evidence: [...shown] });
