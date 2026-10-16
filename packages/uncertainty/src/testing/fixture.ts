import type {
  ClaimFact,
  ContradictionFact,
  CoverageFact,
  DimensionFact,
  EvidenceFact,
  RequirementFact,
  UncertaintyInput,
  UnknownFact,
} from '../types.js';

/*
 * Synthetic inputs for the uncertainty tests. Every record is invented for the test (no real project, no real team) and the ids are
 * readable strings instead of UUIDs: the engine treats ids as opaque.
 */

export const dimension = (id: string, over: Partial<DimensionFact> = {}): DimensionFact => ({
  id,
  criterionKey: id.replace('official.', ''),
  name: id.replace('official.', '').replace(/^./, (c) => c.toUpperCase()),
  criterionWeight: 0.25,
  dimensionWeight: 1,
  state: 'assessed',
  insufficiencyReason: null,
  attribution: 'scored',
  confidence: 0.7,
  evidenceStrength: 0.7,
  citedEvidenceIds: [],
  contradictionIds: [],
  ...over,
});

export const evidence = (id: string, over: Partial<EvidenceFact> = {}): EvidenceFact => ({
  id,
  kind: 'fact',
  origin: 'github',
  verificationLevel: 'repo_corroborated',
  text: `evidence ${id}`,
  ...over,
});

export const claim = (id: string, over: Partial<ClaimFact> = {}): ClaimFact => ({
  id,
  text: `The team states ${id}.`,
  verificationLevel: 'team_claim',
  supportingEvidenceIds: [],
  contradictingEvidenceIds: [],
  ...over,
});

export const unknown = (id: string, over: Partial<UnknownFact> = {}): UnknownFact => ({
  id,
  unknownType: 'unverifiable',
  text: `unknown ${id}`,
  claimIds: [],
  evidenceIds: [],
  ...over,
});

export const contradiction = (
  id: string,
  sides: ContradictionFact['sides'],
  description = `contradiction ${id}`,
): ContradictionFact => ({ id, description, sides });

export const requirement = (id: string, over: Partial<RequirementFact> = {}): RequirementFact => ({
  id,
  kind: 'submission_requirement',
  trackKey: null,
  text: `requirement ${id}`,
  ...over,
});

export const completeCoverage: CoverageFact = {
  status: 'recorded',
  verified: true,
  verdict: 'complete',
  concerns: [],
  missingSources: [],
  partialCapture: false,
  implementation: {
    files: 40,
    filesShown: 40,
    filesUnseen: 0,
    inspectedShare: 1,
    componentsTotal: 4,
    componentsWithShownFile: 4,
  },
  omittedComponents: [],
};

/** Four equally weighted criteria, all assessed on corroborated repository evidence, full coverage: the analysis finds nothing. */
export function quietInput(over: Partial<UncertaintyInput> = {}): UncertaintyInput {
  const names = ['originality', 'technical_depth', 'impact', 'presentation'];
  return {
    assessment: {
      id: 'assessment-1',
      projectId: 'project-1',
      versionNumber: 1,
      reportOutputHash: 'a'.repeat(64),
      contextVersionId: 'context-1',
      contextContentHash: 'b'.repeat(64),
      extractionId: 'extraction-1',
      providerMode: 'scripted',
    },
    rubric: { name: 'Synthetic rubric', weightBasis: 'official' },
    dimensions: names.map((n) => dimension(`official.${n}`, { citedEvidenceIds: [`ev-${n}`] })),
    evidence: names.map((n) => evidence(`ev-${n}`)),
    claims: [],
    unknowns: [],
    contradictions: [],
    coverage: completeCoverage,
    tracks: { declared: [], unassessedTrackRubrics: [] },
    requirements: [],
    ...over,
  };
}
