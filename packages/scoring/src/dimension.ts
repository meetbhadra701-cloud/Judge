import type {
  ConfidenceBasis,
  DimensionJudgment,
  EvidenceRecord,
  InsufficientReason,
  ScoringDiagnostic,
} from '@judge-copilot/schemas';
import { compareText } from './canonical.js';
import { groupByProvenance, type GroupableItem } from './groups.js';
import { mapCitedEvidence } from './lineage.js';
import { contradictionFactor } from './parameters.js';
import type { DimensionSpec, RubricSpec } from './rubric/spec.js';
import { evidenceItemStrength } from './strength.js';
import { channelOf, isUsableKind, resolveEffectiveTrust } from './trust.js';
import type { TrustedScoringContext } from './context.js';

/*
 * Evaluation of ONE dimension (docs/milestones/M4-design.md §5). Pure; every number here is
 * UNROUNDED. The judged score never depends on evidence quality: strength, coverage and confidence
 * are computed beside it and never feed back into it.
 */

export interface DimensionResult {
  readonly spec: DimensionSpec;
  readonly criterionKey: string;
  readonly state: 'assessed' | 'insufficient_evidence';
  readonly reason: InsufficientReason | null;
  /** On the rubric's scale, exactly as judged. Null unless assessed. */
  readonly scoreOnScale: number | null;
  /** Normalized to 0-10. Null unless assessed. */
  readonly score10: number | null;
  readonly strength: number;
  readonly strongestEvidenceIds: readonly string[];
  /** Declared needs only. */
  readonly satisfiedGroups: number | null;
  readonly totalGroups: number | null;
  readonly coverage: number | null;
  /** Unspecified needs only: a flag, not breadth. */
  readonly citationPresence: 0 | 1 | null;
  readonly confidenceBasis: ConfidenceBasis;
  readonly confidence: number;
  readonly contradictionIds: readonly string[];
  readonly mappedClaimIds: ReadonlySet<string>;
  readonly mappedUnknownIds: readonly string[];
  readonly citedEvidenceIds: readonly string[];
  readonly provenanceGroupCount: number;
  readonly diagnostics: readonly ScoringDiagnostic[];
}

/** 10 · (x − min) / (max − min); the identity for the 0-10 scale. Assumes the published scale is linear. */
export function normalizeScore(x: number, scale: RubricSpec['scale']): number {
  if (scale.min === 0 && scale.max === 10) return x;
  return (10 * (x - scale.min)) / (scale.max - scale.min);
}

/** The inverse of {@link normalizeScore}. */
export function denormalizeScore(score10: number, scale: RubricSpec['scale']): number {
  if (scale.min === 0 && scale.max === 10) return score10;
  return scale.min + (score10 / 10) * (scale.max - scale.min);
}

export function evaluateDimension(
  context: TrustedScoringContext,
  criterionKey: string,
  spec: DimensionSpec,
  judgment: DimensionJudgment,
): DimensionResult {
  const { graph, known, rubric } = context;
  const diagnostics: ScoringDiagnostic[] = [];
  const path = `dimensions.${spec.id}`;

  const citedEvidenceIds = judgment.citations.map((c) => c.evidenceId).sort(compareText);
  const cited: { record: EvidenceRecord; directness: string; specificity: string }[] = [];
  const usable: (GroupableItem & { channel: string })[] = [];
  for (const citation of [...judgment.citations].sort((a, b) =>
    compareText(a.evidenceId, b.evidenceId),
  )) {
    const record = graph.evidence.get(citation.evidenceId);
    if (!record) continue; // validated earlier; unreachable for a valid request
    cited.push({ record, directness: citation.directness, specificity: citation.specificity });
    if (!isUsableKind(record.kind)) continue;
    const { level } = resolveEffectiveTrust(record, known);
    usable.push({
      id: record.id,
      strength: evidenceItemStrength(level, citation.directness, citation.specificity),
      snapshotId: record.provenance.snapshotId,
      artifactId: record.provenance.artifactId,
      span: record.provenance.span
        ? { start: record.provenance.span.start, end: record.provenance.span.end }
        : null,
      contextVersionId: record.provenance.contextVersionId,
      channel: channelOf(record, known),
    });
  }

  // Strength: the best provenance group, where a group is as strong as its most conservative member.
  const groups = groupByProvenance(usable);
  let strength = 0;
  for (const group of groups) strength = Math.max(strength, group.strength);
  const strongestEvidenceIds = groups
    .filter((group) => group.strength === strength && strength > 0)
    .flatMap((group) => group.memberIds)
    .sort(compareText);
  for (const group of groups) {
    if (group.memberIds.length < 2) continue;
    diagnostics.push({
      code: 'DUPLICATE_PROVENANCE_GROUPED',
      path,
      entityIds: [...group.memberIds],
      message:
        'Several cited evidence records reference the same passage and count as one source (the lowest of their strengths is used)',
    });
    if (group.inconsistent) {
      diagnostics.push({
        code: 'INCONSISTENT_CLASSIFICATION_RESOLVED',
        path,
        entityIds: [...group.memberIds],
        message:
          'Records of the same passage had different effective strength (levels or classifications); the lowest was used',
      });
    }
  }

  // Coverage against DECLARED needs, or the citation-presence flag where none are declared.
  let satisfiedGroups: number | null = null;
  let totalGroups: number | null = null;
  let coverage: number | null = null;
  let citationPresence: 0 | 1 | null = null;
  if (spec.needGroups !== null) {
    const channels = new Set(usable.map((item) => item.channel));
    totalGroups = spec.needGroups.length;
    satisfiedGroups = spec.needGroups.filter((group) =>
      group.some((channel) => channels.has(channel)),
    ).length;
    coverage = satisfiedGroups / totalGroups;
  } else {
    citationPresence = usable.length > 0 ? 1 : 0;
  }

  const mapping = mapCitedEvidence(graph, citedEvidenceIds);

  const base = {
    spec,
    criterionKey,
    strength,
    strongestEvidenceIds,
    satisfiedGroups,
    totalGroups,
    coverage,
    citationPresence,
    confidenceBasis:
      spec.needGroups !== null
        ? ('declared_needs_coverage' as const)
        : ('citation_presence' as const),
    contradictionIds: mapping.contradictionIds,
    mappedClaimIds: mapping.claimIds,
    mappedUnknownIds: mapping.unknownIds,
    citedEvidenceIds,
    provenanceGroupCount: groups.length,
  };

  const { outcome } = judgment;
  if (outcome.kind === 'insufficient_evidence') {
    return {
      ...base,
      state: 'insufficient_evidence',
      reason: 'assessor_reported_insufficient',
      scoreOnScale: null,
      score10: null,
      confidence: 0,
      diagnostics,
    };
  }
  if (usable.length === 0) {
    // Missing evidence is not negative evidence: a value with nothing usable behind it is not a score.
    diagnostics.push({
      code: 'JUDGED_VALUE_NOT_USED',
      path,
      entityIds: [...citedEvidenceIds],
      message: `A judged value (${String(outcome.score)} on the scale ${String(rubric.scale.min)} to ${String(rubric.scale.max)}) was not used because no usable evidence was cited; the dimension is insufficient_evidence`,
    });
    return {
      ...base,
      state: 'insufficient_evidence',
      reason: 'no_usable_citation',
      scoreOnScale: null,
      score10: null,
      confidence: 0,
      diagnostics,
    };
  }

  const basisFactor = coverage ?? citationPresence ?? 0;
  const confidence = basisFactor * strength * contradictionFactor(mapping.contradictionIds.length);
  return {
    ...base,
    state: 'assessed',
    reason: null,
    scoreOnScale: outcome.score,
    score10: normalizeScore(outcome.score, rubric.scale),
    confidence,
    diagnostics,
  };
}
