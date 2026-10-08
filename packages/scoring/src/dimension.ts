import type {
  ConfidenceBasis,
  DimensionJudgment,
  InsufficientReason,
  ScoringDiagnostic,
} from '@judge-copilot/schemas';
import { compareText } from './canonical.js';
import type { ScoringState } from './context.js';
import { groupByProvenance, type GroupableItem } from './groups.js';
import { mapCitedEvidence } from './lineage.js';
import { contradictionFactor } from './parameters.js';
import {
  add,
  div,
  eq,
  fromInt,
  fromNumber,
  gt,
  max,
  mul,
  sub,
  ZERO,
  type Rational,
} from './rational.js';
import type { DimensionSpec, RubricSpec } from './rubric/spec.js';
import { evidenceItemStrength } from './strength.js';
import { channelOf, isUsableKind, resolveEffectiveTrust } from './trust.js';

/*
 * Evaluation of ONE dimension (docs/milestones/M4-design.md §5). Pure; every number here is an EXACT
 * rational (see rational.ts) and is rounded only when the report is built. The judged score never
 * depends on evidence quality: strength, coverage and confidence are computed beside it and never
 * feed back into it.
 */

export interface DimensionResult {
  readonly spec: DimensionSpec;
  readonly criterionKey: string;
  readonly state: 'assessed' | 'insufficient_evidence';
  readonly reason: InsufficientReason | null;
  /** On the rubric's scale, exactly as judged. Null unless assessed. */
  readonly scoreOnScale: Rational | null;
  /** Normalized to 0-10. Null unless assessed. */
  readonly score10: Rational | null;
  readonly strength: Rational;
  readonly strongestEvidenceIds: readonly string[];
  /** Declared needs only. */
  readonly satisfiedGroups: number | null;
  readonly totalGroups: number | null;
  readonly coverage: Rational | null;
  /** Unspecified needs only: a flag, not breadth. */
  readonly citationPresence: 0 | 1 | null;
  readonly confidenceBasis: ConfidenceBasis;
  readonly confidence: Rational;
  readonly contradictionIds: readonly string[];
  readonly mappedClaimIds: ReadonlySet<string>;
  readonly mappedUnknownIds: readonly string[];
  readonly citedEvidenceIds: readonly string[];
  readonly provenanceGroupCount: number;
  readonly diagnostics: readonly ScoringDiagnostic[];
}

const TEN = fromInt(10);

/**
 * 10 · (x − min) / (max − min), exactly. ASSUMES the published scale is linear (equal steps are
 * equally valuable). The scale itself has been checked for safety by `validateOfficialScale`.
 */
export function normalizeScore(x: Rational, scale: RubricSpec['scale']): Rational {
  const low = fromNumber(scale.min);
  return div(mul(TEN, sub(x, low)), sub(fromNumber(scale.max), low));
}

/** The inverse of {@link normalizeScore}, exactly. */
export function denormalizeScore(score10: Rational, scale: RubricSpec['scale']): Rational {
  const low = fromNumber(scale.min);
  return add(low, mul(div(score10, TEN), sub(fromNumber(scale.max), low)));
}

export function evaluateDimension(
  state: ScoringState,
  criterionKey: string,
  spec: DimensionSpec,
  judgment: DimensionJudgment,
): DimensionResult {
  const { graph, known, rubric } = state;
  const diagnostics: ScoringDiagnostic[] = [];
  const path = `dimensions.${spec.id}`;

  const citedEvidenceIds = judgment.citations.map((c) => c.evidenceId).sort(compareText);
  const usable: (GroupableItem & { channel: string })[] = [];
  for (const citation of [...judgment.citations].sort((a, b) =>
    compareText(a.evidenceId, b.evidenceId),
  )) {
    const record = graph.evidence.get(citation.evidenceId);
    if (!record) continue; // validated earlier; unreachable for a valid request
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
  // (A weaker record that overlaps a stronger one LOWERS the group: intentional, see SCORING.md §13.)
  const groups = groupByProvenance(usable);
  let strength = ZERO;
  for (const group of groups) strength = max(strength, group.strength);
  const strongestEvidenceIds = groups
    .filter((group) => gt(group.strength, ZERO) && eq(group.strength, strength))
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
  let coverage: Rational | null = null;
  let citationPresence: 0 | 1 | null = null;
  if (spec.needGroups !== null) {
    const channels = new Set(usable.map((item) => item.channel));
    totalGroups = spec.needGroups.length;
    satisfiedGroups = spec.needGroups.filter((group) =>
      group.some((channel) => channels.has(channel)),
    ).length;
    coverage = div(fromInt(satisfiedGroups), fromInt(totalGroups));
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
      confidence: ZERO,
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
      confidence: ZERO,
      diagnostics,
    };
  }

  const basisFactor = coverage ?? fromInt(citationPresence ?? 0);
  const confidence = mul(
    mul(basisFactor, strength),
    contradictionFactor(mapping.contradictionIds.length),
  );
  const judged = fromNumber(outcome.score);
  return {
    ...base,
    state: 'assessed',
    reason: null,
    scoreOnScale: judged,
    score10: normalizeScore(judged, rubric.scale),
    confidence,
    diagnostics,
  };
}
