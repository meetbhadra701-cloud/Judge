import { canonicalJson, sha256Hex } from '@judge-copilot/context';
import type {
  ExpectedInformation,
  UncertaintyKind,
  UncertaintySeverity,
  VerificationLevel,
} from '@judge-copilot/schemas';
import {
  UncertaintyInputError,
  type DimensionFact,
  type TrailEntry,
  type UncertaintyInput,
  type UncertaintyOpportunity,
  type UncertaintyReport,
} from './types.js';

/*
 * uncertainty-engine/v1. The question it answers: "what could make this assessment wrong, incomplete or materially misleading?"
 *
 * Principles (docs/ARCHITECTURE.md invariants 3, 4, 14, 25):
 *   - MISSING EVIDENCE IS UNCERTAINTY, NEVER A DEFICIENCY. No rule here reads a score as a defect: a dimension with a low score and strong evidence produces
 *     nothing, and no opportunity states or implies that the project is weak.
 *   - A TEAM STATEMENT IS A CLAIM until corroborated. Material that is only a team statement is flagged as resting on claims, never as false.
 *   - PRESENTATION IS NOT A DEFICIENCY. Thin or absent documentation is not an opportunity of any kind; only a MISSING expected source or an unseen part of the
 *     implementation is.
 *   - NOTHING ACCUSES. Contradictions are recorded inconsistencies for a judge to ask about.
 *   - REPRODUCIBLE. Every opportunity carries a trail of stored ids that exist in the input, and an id derived from them.
 * The analysis changes no score and no weight: it has no output that any scorer reads.
 */

/** Verification labels that mean something beyond the team's own say-so. A label is never proof; it decides only whether a claim is still just a claim. */
const CORROBORATED_LEVELS: ReadonlySet<VerificationLevel> = new Set([
  'repo_corroborated',
  'machine_verified',
  'judge_verified',
  'live_verified',
]);

/** Thresholds of this policy (documented in the M6 report; changing one is a new engine version). */
export const THRESHOLDS = {
  /** A dimension that carries at least this share of the overall rubric is "dominant". */
  dominantShare: 0.25,
  /** ... and at least this share is "material". */
  materialShare: 0.1,
  /** An assessed dimension whose evidence-strength index is below this rests on thin evidence. */
  thinEvidenceStrength: 0.35,
  /** ... or whose confidence index is below this. */
  thinConfidence: 0.25,
  /** Below this inspected share of the implementation, the unseen part is a high-severity uncertainty. */
  implementationHighConcern: 0.5,
  excerptChars: 200,
  trailMax: 12,
} as const;

const SEVERITY_ORDER: Readonly<Record<UncertaintySeverity, number>> = {
  critical: 0,
  high: 1,
  moderate: 2,
  low: 3,
};
const BUMP: Readonly<Record<UncertaintySeverity, UncertaintySeverity>> = {
  critical: 'critical',
  high: 'critical',
  moderate: 'high',
  low: 'moderate',
};

const KIND_ORDER: readonly UncertaintyKind[] = [
  'source_missing',
  'dimension_not_assessed',
  'coverage_partial',
  'dimension_rests_on_claims',
  'contradiction_recorded',
  'claim_unverified',
  'requirement_unaddressed',
  'track_rubric_not_assessed',
  'unknown_recorded',
  'thin_evidence',
];

/** What kinds of answer could settle each kind of uncertainty (a fixed table: the model does not decide it). */
const CLARIFIED_BY: Readonly<Record<UncertaintyKind, readonly ExpectedInformation[]>> = {
  dimension_not_assessed: ['live_demonstration', 'code_walkthrough', 'explanation'],
  dimension_rests_on_claims: ['live_demonstration', 'code_walkthrough'],
  claim_unverified: ['live_demonstration', 'code_walkthrough', 'link_or_document'],
  contradiction_recorded: ['explanation', 'link_or_document'],
  unknown_recorded: ['explanation', 'link_or_document'],
  source_missing: ['link_or_document', 'code_walkthrough'],
  coverage_partial: ['code_walkthrough', 'live_demonstration'],
  requirement_unaddressed: ['explanation', 'live_demonstration', 'link_or_document'],
  track_rubric_not_assessed: ['explanation', 'live_demonstration'],
  thin_evidence: ['explanation', 'measurement'],
};

const UNKNOWN_SEVERITY: Readonly<Record<string, UncertaintySeverity>> = {
  contradictory: 'high',
  eligibility: 'high',
  unverifiable: 'moderate',
  ambiguous: 'moderate',
  missing: 'moderate',
  subjective: 'low',
};

const excerpt = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= THRESHOLDS.excerptChars
    ? flat
    : `${flat.slice(0, THRESHOLDS.excerptChars - 1).trimEnd()}…`;
};

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
const sorted = (values: readonly string[]): string[] =>
  [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function validate(input: UncertaintyInput): void {
  const issues: string[] = [];
  const dimensionIds = new Set<string>();
  for (const dimension of input.dimensions) {
    if (dimensionIds.has(dimension.id)) issues.push(`duplicate dimension ${dimension.id}`);
    dimensionIds.add(dimension.id);
  }
  const evidenceIds = new Set(input.evidence.map((item) => item.id));
  const claimIds = new Set(input.claims.map((claim) => claim.id));
  const contradictionIds = new Set(input.contradictions.map((c) => c.id));
  const known = (id: string, set: ReadonlySet<string>, what: string, where: string): void => {
    if (!set.has(id)) issues.push(`${where} references unknown ${what} ${id}`);
  };
  for (const dimension of input.dimensions) {
    for (const id of dimension.citedEvidenceIds)
      known(id, evidenceIds, 'evidence', `dimension ${dimension.id}`);
    for (const id of dimension.contradictionIds)
      known(id, contradictionIds, 'contradiction', `dimension ${dimension.id}`);
    if (dimension.state === 'insufficient_evidence' && dimension.insufficiencyReason === null) {
      issues.push(`dimension ${dimension.id} is insufficient without a reason`);
    }
  }
  for (const claim of input.claims) {
    for (const id of [...claim.supportingEvidenceIds, ...claim.contradictingEvidenceIds]) {
      known(id, evidenceIds, 'evidence', `claim ${claim.id}`);
    }
  }
  for (const unknown of input.unknowns) {
    for (const id of unknown.claimIds) known(id, claimIds, 'claim', `unknown ${unknown.id}`);
    for (const id of unknown.evidenceIds)
      known(id, evidenceIds, 'evidence', `unknown ${unknown.id}`);
  }
  for (const contradiction of input.contradictions) {
    if (contradiction.sides.length !== 2)
      issues.push(`contradiction ${contradiction.id} must have two sides`);
    for (const side of contradiction.sides) {
      known(
        side.id,
        side.type === 'claim' ? claimIds : evidenceIds,
        side.type,
        `contradiction ${contradiction.id}`,
      );
    }
  }
  const declared = new Set(input.tracks.declared.map((track) => track.key));
  for (const requirement of input.requirements) {
    if (requirement.trackKey !== null && !declared.has(requirement.trackKey)) {
      issues.push(
        `requirement ${requirement.id} belongs to an undeclared track ${requirement.trackKey}`,
      );
    }
  }
  for (const rubric of input.tracks.unassessedTrackRubrics) {
    if (!declared.has(rubric.trackKey))
      issues.push(`a track rubric names an undeclared track ${rubric.trackKey}`);
  }
  if (input.dimensions.length === 0) issues.push('the assessment has no dimensions');
  if (issues.length > 0) throw new UncertaintyInputError(issues);
}

/** The share of the overall rubric a dimension carries (official weights), or an equal share used ONLY for ordering when the rubric is unweighted. */
function weightShares(input: UncertaintyInput): {
  shares: Map<string, number>;
  basis: 'official' | 'equal_for_ranking_only';
} {
  const shares = new Map<string, number>();
  const weighted =
    input.rubric.weightBasis === 'official' &&
    input.dimensions.every((d) => d.criterionWeight !== null);
  if (weighted) {
    for (const dimension of input.dimensions) {
      shares.set(dimension.id, (dimension.criterionWeight ?? 0) * dimension.dimensionWeight);
    }
    return { shares, basis: 'official' };
  }
  for (const dimension of input.dimensions) shares.set(dimension.id, 1 / input.dimensions.length);
  return { shares, basis: 'equal_for_ranking_only' };
}

interface Draft {
  readonly kind: UncertaintyKind;
  readonly severity: UncertaintySeverity;
  readonly dimensionIds: readonly string[];
  readonly observation: string;
  readonly trail: readonly TrailEntry[];
  /** The ids that make this opportunity THIS opportunity (the identity preimage). */
  readonly subject: readonly string[];
}

export function analyzeUncertainty(input: UncertaintyInput): UncertaintyReport {
  validate(input);
  const { shares, basis } = weightShares(input);
  const shareOf = (id: string): number => shares.get(id) ?? 0;
  const evidenceById = new Map(input.evidence.map((e) => [e.id, e] as const));
  const claimById = new Map(input.claims.map((c) => [c.id, c] as const));

  const severityByWeight = (
    ids: readonly string[],
    base: UncertaintySeverity,
  ): UncertaintySeverity => {
    const share = Math.max(0, ...ids.map(shareOf));
    return share >= THRESHOLDS.dominantShare ? BUMP[base] : base;
  };

  // dimension -> cited evidence; evidence -> dimensions that cite it
  const dimensionsCiting = new Map<string, string[]>();
  for (const dimension of input.dimensions) {
    for (const id of dimension.citedEvidenceIds) {
      dimensionsCiting.set(id, [...(dimensionsCiting.get(id) ?? []), dimension.id]);
    }
  }
  const dimensionsOfEvidence = (ids: readonly string[]): string[] =>
    sorted(unique(ids.flatMap((id) => dimensionsCiting.get(id) ?? [])));
  const dimensionsOfClaim = (claimId: string): string[] => {
    const claim = claimById.get(claimId);
    if (!claim) return [];
    return dimensionsOfEvidence([
      ...claim.supportingEvidenceIds,
      ...claim.contradictingEvidenceIds,
    ]);
  };

  const claimLike = (id: string): boolean => {
    const item = evidenceById.get(id);
    return (
      item !== undefined &&
      (item.kind === 'claim' ||
        item.verificationLevel === 'team_claim' ||
        item.origin === 'devpost' ||
        item.origin === 'video')
    );
  };
  const observationLike = (id: string): boolean => {
    const item = evidenceById.get(id);
    return (
      item !== undefined &&
      !claimLike(id) &&
      item.kind === 'fact' &&
      (item.origin === 'github' || item.origin === 'deployment')
    );
  };

  const drafts: Draft[] = [];
  const add = (draft: Draft): void => {
    drafts.push({
      ...draft,
      dimensionIds: sorted(unique(draft.dimensionIds)),
      trail: draft.trail.slice(0, THRESHOLDS.trailMax),
    });
  };
  const dimTrail = (ids: readonly string[], role: TrailEntry['role'] = 'subject'): TrailEntry[] =>
    sorted(ids).map((id) => ({ type: 'dimension', id, role }));

  // 1. a dimension with no number
  for (const dimension of input.dimensions.filter((d) => d.state === 'insufficient_evidence')) {
    const who =
      dimension.attribution === 'insufficient_by_assessor'
        ? 'the assessor itself reported that it could not judge this criterion (that statement was not independently reviewed)'
        : dimension.insufficiencyReason === 'no_usable_citation'
          ? 'the only material cited for this criterion could not be used to score it'
          : 'the evidence available did not allow this criterion to be scored';
    add({
      kind: 'dimension_not_assessed',
      // no number at all is the largest uncertainty a dimension can have: its severity follows the weight it carries
      severity:
        shareOf(dimension.id) >= THRESHOLDS.dominantShare
          ? 'critical'
          : shareOf(dimension.id) >= THRESHOLDS.materialShare
            ? 'high'
            : 'moderate',
      dimensionIds: [dimension.id],
      observation: `No score was given for “${dimension.name}”: ${who}. This is missing evidence, not a low score.`,
      trail: [
        ...dimTrail([dimension.id]),
        ...dimension.citedEvidenceIds.map((id): TrailEntry => ({
          type: 'evidence',
          id,
          role: 'context',
        })),
      ],
      subject: [dimension.id],
    });
  }

  // 2. an assessed dimension that rests ONLY on team statements
  const restsOnClaims = new Set<string>();
  for (const dimension of input.dimensions.filter((d) => d.state === 'assessed')) {
    const cited = dimension.citedEvidenceIds;
    if (cited.length === 0 || cited.some(observationLike)) continue;
    restsOnClaims.add(dimension.id);
    add({
      kind: 'dimension_rests_on_claims',
      severity: shareOf(dimension.id) >= THRESHOLDS.materialShare ? 'high' : 'moderate',
      dimensionIds: [dimension.id],
      observation: `The score for “${dimension.name}” rests only on what the team's own materials say. Nothing the assessment was shown (such as the project's code or a live check) corroborates it yet, so its accuracy is not established.`,
      trail: [
        ...dimTrail([dimension.id]),
        ...cited.map((id): TrailEntry => ({ type: 'evidence', id, role: 'support' })),
      ],
      subject: [dimension.id],
    });
  }

  // 3. a team claim that bears on a dimension and is not corroborated
  let unlinkedClaims = 0;
  let corroboratedClaims = 0;
  for (const claim of input.claims) {
    if (CORROBORATED_LEVELS.has(claim.verificationLevel)) {
      corroboratedClaims += 1;
      continue;
    }
    const dims = dimensionsOfClaim(claim.id);
    if (dims.length === 0) {
      unlinkedClaims += 1;
      continue;
    }
    add({
      kind: 'claim_unverified',
      severity: dims.some((d) => shareOf(d) >= THRESHOLDS.dominantShare) ? 'high' : 'moderate',
      dimensionIds: dims,
      observation: `The team's materials state: “${excerpt(claim.text)}”. This is a claim by the team; nothing the assessment was shown confirms it yet.`,
      trail: [
        { type: 'claim', id: claim.id, role: 'subject' },
        ...claim.supportingEvidenceIds.map((id): TrailEntry => ({
          type: 'evidence',
          id,
          role: 'support',
        })),
        ...claim.contradictingEvidenceIds.map((id): TrailEntry => ({
          type: 'evidence',
          id,
          role: 'conflict',
        })),
        ...dimTrail(dims, 'context'),
      ],
      subject: [claim.id],
    });
  }

  // 4. a recorded contradiction (an inconsistency for a judge to ask about, never an accusation)
  for (const contradiction of input.contradictions) {
    const sideIds = contradiction.sides.map((s) => s.id);
    const sideEvidence = contradiction.sides.flatMap((s) =>
      s.type === 'evidence' ? [s.id] : (claimById.get(s.id)?.supportingEvidenceIds ?? []),
    );
    const dims = sorted(
      unique([
        ...input.dimensions
          .filter((d) => d.contradictionIds.includes(contradiction.id))
          .map((d) => d.id),
        ...dimensionsOfEvidence(sideEvidence),
      ]),
    );
    add({
      kind: 'contradiction_recorded',
      severity: severityByWeight(dims, 'high'),
      dimensionIds: dims,
      observation: `Two parts of the material seem to say different things: ${excerpt(contradiction.description)} This is a recorded inconsistency to ask about, not a conclusion.`,
      trail: [
        { type: 'contradiction', id: contradiction.id, role: 'subject' },
        ...contradiction.sides.map((s): TrailEntry => ({
          type: s.type,
          id: s.id,
          role: 'conflict',
        })),
        ...dimTrail(dims, 'context'),
      ],
      subject: [contradiction.id, ...sideIds],
    });
  }

  // 5. a recorded unknown
  for (const unknown of input.unknowns) {
    const viaClaims = unknown.claimIds.flatMap(dimensionsOfClaim);
    const dims = sorted(unique([...dimensionsOfEvidence(unknown.evidenceIds), ...viaClaims]));
    const base = UNKNOWN_SEVERITY[unknown.unknownType] ?? 'moderate';
    add({
      kind: 'unknown_recorded',
      severity:
        dims.length > 0 ? severityByWeight(dims, base) : base === 'low' ? 'low' : 'moderate',
      dimensionIds: dims,
      observation: `Recorded gap (${unknown.unknownType}): ${excerpt(unknown.text)}`,
      trail: [
        { type: 'unknown', id: unknown.id, role: 'subject' },
        ...unknown.claimIds.map((id): TrailEntry => ({ type: 'claim', id, role: 'context' })),
        ...unknown.evidenceIds.map((id): TrailEntry => ({ type: 'evidence', id, role: 'context' })),
        ...dimTrail(dims, 'context'),
      ],
      subject: [unknown.id],
    });
  }

  // 6. an expected source with no usable capture
  const allDimensions = input.dimensions.map((d) => d.id);
  for (const source of input.coverage.missingSources) {
    add({
      kind: 'source_missing',
      severity: source === 'github' ? 'critical' : 'high',
      dimensionIds: allDimensions,
      observation:
        source === 'github'
          ? 'No usable capture of the project’s GitHub repository was available to the assessment, so nothing about its implementation was examined. This is missing evidence, not a finding about the project.'
          : 'No usable capture of the project’s Devpost page was available to the assessment, so what the team says about its project was not examined. This is missing evidence, not a finding about the project.',
      trail: [
        { type: 'coverage', id: `missing_source:${source}`, role: 'subject' },
        ...dimTrail(allDimensions, 'context'),
      ],
      subject: [`missing_source:${source}`],
    });
  }

  // 7. part of the implementation that the assessment never saw
  const coverage = input.coverage;
  const implementation = coverage.implementation;
  const githubMissing = coverage.missingSources.includes('github');
  const unseenImplementation =
    implementation !== null &&
    (implementation.filesUnseen > 0 || implementation.inspectedShare < 1);
  const coverageUnknown = coverage.status === 'not_recorded' || !coverage.verified;
  if (
    !githubMissing &&
    (coverage.verdict === 'partial' ||
      coverage.verdict === 'insufficient' ||
      unseenImplementation ||
      coverage.partialCapture ||
      coverageUnknown)
  ) {
    const citingImplementation = input.dimensions
      .filter((d) => d.citedEvidenceIds.some(observationLike))
      .map((d) => d.id);
    const dims = citingImplementation.length > 0 ? citingImplementation : allDimensions;
    const parts: string[] = [];
    if (coverageUnknown) {
      parts.push(
        'how much of the project’s material the assessment examined was not recorded for this assessment, so its coverage is unknown (not “complete”)',
      );
    } else {
      if (implementation !== null && unseenImplementation) {
        parts.push(
          `${String(implementation.filesUnseen)} of ${String(implementation.files)} implementation files were not shown to the assessment (${String(Math.round(implementation.inspectedShare * 100))}% of the implementation was inspected)`,
        );
      }
      if (coverage.omittedComponents.length > 0) {
        parts.push(
          `parts not fully inspected: ${coverage.omittedComponents.slice(0, 3).map(excerpt).join(', ')}`,
        );
      }
      if (coverage.partialCapture)
        parts.push(
          'a capture was itself partial, so material beyond its limits was never obtained',
        );
    }
    const severity: UncertaintySeverity =
      coverage.verdict === 'insufficient'
        ? 'critical'
        : coverageUnknown
          ? 'moderate'
          : implementation !== null &&
              implementation.inspectedShare < THRESHOLDS.implementationHighConcern
            ? 'high'
            : 'moderate';
    add({
      kind: 'coverage_partial',
      severity,
      dimensionIds: dims,
      observation:
        `${parts.length > 0 ? parts.join('; ') : 'the assessment did not examine all of the material'}. What was not examined is unknown, not weak.`.replace(
          /^./,
          (c) => c.toUpperCase(),
        ),
      trail: [
        { type: 'coverage', id: 'implementation_coverage', role: 'subject' },
        ...dimTrail(dims, 'context'),
      ],
      subject: ['implementation_coverage'],
    });
  }

  // 8. official requirements that nothing has shown the project to meet (the assessment cites a requirement only as context)
  const trackRequirements = input.requirements.filter((r) => r.trackKey !== null);
  const trackNameOf = (key: string): string =>
    input.tracks.declared.find((t) => t.key === key)?.name ?? key;
  for (const requirement of trackRequirements) {
    add({
      kind: 'requirement_unaddressed',
      severity: 'high',
      dimensionIds: [],
      observation: `The ${trackNameOf(requirement.trackKey ?? '')} track states: “${excerpt(requirement.text)}”. The assessment cites this only as what the track requires; nothing it examined shows whether the project meets it.`,
      trail: [
        { type: 'requirement', id: requirement.id, role: 'subject' },
        { type: 'track', id: requirement.trackKey ?? '', role: 'context' },
      ],
      subject: [requirement.id],
    });
  }
  const overall = input.requirements.filter((r) => r.trackKey === null);
  if (overall.length > 0) {
    const eligibility = input.unknowns.some((u) => u.unknownType === 'eligibility');
    add({
      kind: 'requirement_unaddressed',
      severity: eligibility ? 'moderate' : 'low',
      dimensionIds: [],
      observation: `The event states ${String(overall.length)} rule${overall.length === 1 ? '' : 's'} for every project (for example “${excerpt(overall[0]?.text ?? '')}”). The assessment cites these only as what the event requires; nothing it examined shows whether the project meets them.`,
      trail: sorted(overall.map((r) => r.id)).map((id): TrailEntry => ({
        type: 'requirement',
        id,
        role: 'subject',
      })),
      subject: sorted(overall.map((r) => r.id)),
    });
  }

  // 9. a track's own rubric, which this version does not score
  for (const rubric of input.tracks.unassessedTrackRubrics) {
    add({
      kind: 'track_rubric_not_assessed',
      severity: 'high',
      dimensionIds: [],
      observation: `The project entered the ${rubric.trackName} track, which publishes its own criteria (“${rubric.rubricName}”). The assessment scored only the event's overall rubric, so those track criteria have no result.`,
      trail: [{ type: 'track', id: rubric.trackKey, role: 'subject' }],
      subject: [`track_rubric:${rubric.trackKey}`],
    });
  }

  // 10. a scored dimension whose own indices say the evidence behind it is thin
  for (const dimension of input.dimensions.filter(
    (d) => d.state === 'assessed' && !restsOnClaims.has(d.id),
  )) {
    const thin =
      (dimension.evidenceStrength !== null &&
        dimension.evidenceStrength < THRESHOLDS.thinEvidenceStrength) ||
      dimension.confidence < THRESHOLDS.thinConfidence;
    if (!thin) continue;
    add({
      kind: 'thin_evidence',
      severity: shareOf(dimension.id) >= THRESHOLDS.dominantShare ? 'high' : 'moderate',
      dimensionIds: [dimension.id],
      observation: `“${dimension.name}” was scored on a small amount of evidence (the assessment's own confidence index for it is ${String(Math.round(dimension.confidence * 100))}%). The score may move with more evidence in either direction.`,
      trail: [
        ...dimTrail([dimension.id]),
        ...dimension.citedEvidenceIds.map((id): TrailEntry => ({
          type: 'evidence',
          id,
          role: 'support',
        })),
      ],
      subject: [dimension.id],
    });
  }

  // identity, relevance and the deterministic order
  const built = drafts.map((draft) => {
    const dims = draft.dimensionIds;
    const relevance =
      dims.length > 0
        ? Math.min(
            1,
            dims.reduce((sum, id) => sum + shareOf(id), 0),
          )
        : 0;
    const id = `opp-${sha256Hex(canonicalJson({ kind: draft.kind, subject: sorted(draft.subject) })).slice(0, 16)}`;
    return { draft, id, relevanceMilli: Math.round(relevance * 1000) };
  });
  built.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.draft.severity] - SEVERITY_ORDER[b.draft.severity];
    if (bySeverity !== 0) return bySeverity;
    if (b.relevanceMilli !== a.relevanceMilli) return b.relevanceMilli - a.relevanceMilli;
    const byKind = KIND_ORDER.indexOf(a.draft.kind) - KIND_ORDER.indexOf(b.draft.kind);
    if (byKind !== 0) return byKind;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const seen = new Set<string>();
  const opportunities: UncertaintyOpportunity[] = [];
  for (const { draft, id, relevanceMilli } of built) {
    if (seen.has(id)) continue; // the same subject cannot be an opportunity twice
    seen.add(id);
    opportunities.push({
      id,
      ordinal: opportunities.length + 1,
      kind: draft.kind,
      severity: draft.severity,
      dimensionIds: draft.dimensionIds,
      relevanceMilli,
      observation: draft.observation,
      clarifiedBy: CLARIFIED_BY[draft.kind],
      trail: draft.trail,
    });
  }
  return {
    engineVersion: 'uncertainty-engine/v1',
    weightBasis: basis,
    dimensions: input.dimensions.map((d: DimensionFact) => ({
      id: d.id,
      name: d.name,
      weightShareMilli: Math.round(shareOf(d.id) * 1000),
    })),
    opportunities,
    suppressed: { unlinkedClaims, corroboratedClaims },
  };
}
