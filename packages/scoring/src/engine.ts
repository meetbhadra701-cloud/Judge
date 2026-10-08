import {
  AssessorJudgmentsInput,
  SCORING_ENGINE_VERSION,
  ScoreReport,
  ScoringOptions,
  type ClaimLineage,
  type DimensionJudgment,
  type DimensionReport,
  type RubricIdentity,
  type ScoreReportBody,
  type ScoringDiagnostic,
  type ScoringIssue,
} from '@judge-copilot/schemas';
import { aggregate } from './aggregate.js';
import { clampRatio, compareText, hashOf, roundReported } from './canonical.js';
import { sortIssues, stateOf, type ScoringState, type TrustedScoringContext } from './context.js';
import { evaluateDimension, type DimensionResult } from './dimension.js';
import { lineageOf } from './lineage.js';
import { parametersHash } from './parameters-hash.js';
import { clamp, fromInt, ZERO, type Rational } from './rational.js';
import type { DimensionSpec } from './rubric/spec.js';

/*
 * scoring-engine/v1. Pure and deterministic: the same trusted context, judgments and options always
 * give a byte-identical report (and `outputHash`). There is no model call, prompt, network access,
 * clock, randomness or persistence anywhere in this package.
 *
 * Inputs by trust:
 *   TRUSTED   `context`  rubric, evidence graph + source facts, declared tracks (built by trusted code)
 *   CALLER    `options`  explicit request for the unofficial equal-weight preview
 *   UNTRUSTED `judgments` the assessor's scores and classified citations (strict Zod; nothing else)
 *
 * It validates structure only. It does NOT verify that a cited item is semantically relevant to its
 * dimension or that a judgment is right; that remains a prerequisite of the assessment milestone.
 */

export type ScoreResult =
  | { readonly ok: true; readonly report: ScoreReport }
  | { readonly ok: false; readonly issues: readonly ScoringIssue[] };

export function scoreProject(
  context: TrustedScoringContext,
  rawJudgments: unknown,
  rawOptions: unknown = {},
): ScoreResult {
  // The authoritative graph lives in private state keyed by the factory-created context object; an
  // object that did not come from the factory (or a copy of one) has none and is refused.
  const state = stateOf(context);
  if (!state) {
    return {
      ok: false,
      issues: [
        {
          code: 'UNTRUSTED_CONTEXT',
          path: 'context',
          message: 'The scoring context was not created by createTrustedScoringContext',
        },
      ],
    };
  }

  const issues: ScoringIssue[] = [];

  const version = (rawJudgments as { engineVersion?: unknown } | null)?.engineVersion;
  if (
    typeof rawJudgments === 'object' &&
    rawJudgments !== null &&
    'engineVersion' in rawJudgments &&
    version !== SCORING_ENGINE_VERSION
  ) {
    issues.push({
      code: 'ENGINE_VERSION_MISMATCH',
      path: 'engineVersion',
      message: `Expected ${SCORING_ENGINE_VERSION}`,
    });
  }

  const options = ScoringOptions.safeParse(rawOptions);
  if (!options.success) {
    for (const entry of options.error.issues.slice(0, 20)) {
      issues.push({
        code: 'INVALID_INPUT',
        path: `options.${entry.path.join('.')}`,
        message: entry.message,
      });
    }
  }
  const parsed = AssessorJudgmentsInput.safeParse(rawJudgments);
  if (!parsed.success && !issues.some((entry) => entry.code === 'ENGINE_VERSION_MISMATCH')) {
    for (const entry of parsed.error.issues.slice(0, 50)) {
      issues.push({ code: 'INVALID_INPUT', path: entry.path.join('.'), message: entry.message });
    }
  }
  if (issues.length > 0 || !parsed.success || !options.success) {
    return { ok: false, issues: sortIssues(issues) };
  }

  const { rubric } = state;
  const wantsPreview = options.data.unweightedPreview === 'equal_weight';
  if (wantsPreview && rubric.weightBasis !== 'unweighted_official') {
    return {
      ok: false,
      issues: [
        {
          code: 'UNWEIGHTED_PREVIEW_NOT_APPLICABLE',
          path: 'options.unweightedPreview',
          message: 'A preview exists only for an unweighted official rubric',
        },
      ],
    };
  }

  const dimensions = new Map<string, { criterionKey: string; spec: DimensionSpec }>();
  const notApplicable = new Set<string>();
  for (const criterion of rubric.criteria) {
    for (const spec of criterion.dimensions) {
      if (criterion.applicable) dimensions.set(spec.id, { criterionKey: criterion.key, spec });
      else notApplicable.add(spec.id);
    }
  }

  const byDimension = new Map<string, DimensionJudgment>();
  parsed.data.judgments.forEach((judgment, index) => {
    const at = `judgments[${String(index)}]`;
    if (notApplicable.has(judgment.dimensionId)) {
      issues.push({
        code: 'JUDGMENT_FOR_NOT_APPLICABLE_DIMENSION',
        path: `${at}.dimensionId`,
        message: 'This dimension is not applicable to the project',
      });
      return;
    }
    if (!dimensions.has(judgment.dimensionId)) {
      issues.push({
        code: 'UNKNOWN_DIMENSION',
        path: `${at}.dimensionId`,
        message: 'The dimension is not part of the selected rubric',
      });
      return;
    }
    if (byDimension.has(judgment.dimensionId)) {
      issues.push({
        code: 'JUDGMENT_DUPLICATE',
        path: `${at}.dimensionId`,
        message: 'More than one judgment for the same dimension',
      });
      return;
    }
    byDimension.set(judgment.dimensionId, judgment);

    if (judgment.outcome.kind === 'scored') {
      const { score } = judgment.outcome;
      if (!Number.isFinite(score)) {
        issues.push({
          code: 'SCORE_NOT_FINITE',
          path: `${at}.outcome.score`,
          message: 'The score must be finite',
        });
      } else if (score < rubric.scale.min || score > rubric.scale.max) {
        issues.push({
          code: 'SCORE_OUT_OF_SCALE',
          path: `${at}.outcome.score`,
          message: `The score must lie within the rubric scale ${String(rubric.scale.min)} to ${String(rubric.scale.max)}`,
        });
      }
    }
    const seen = new Set<string>();
    judgment.citations.forEach((citation, citationIndex) => {
      const cpath = `${at}.citations[${String(citationIndex)}].evidenceId`;
      if (seen.has(citation.evidenceId)) {
        issues.push({
          code: 'CITATION_DUPLICATE',
          path: cpath,
          message: 'The same evidence item is cited twice in one judgment',
        });
      }
      seen.add(citation.evidenceId);
      // Invented IDs and evidence of any other project are indistinguishable here, and both fail.
      if (!state.graph.evidence.has(citation.evidenceId)) {
        issues.push({
          code: 'CITATION_UNKNOWN_EVIDENCE',
          path: cpath,
          message: 'The cited evidence is not an evidence item of this project',
        });
      }
    });
  });
  for (const id of [...dimensions.keys()].sort(compareText)) {
    if (!byDimension.has(id)) {
      issues.push({
        code: 'JUDGMENT_MISSING',
        path: `dimensions.${id}`,
        message: 'Every dimension of the selected rubric needs exactly one judgment',
      });
    }
  }
  if (issues.length > 0) return { ok: false, issues: sortIssues(issues) };

  // Evaluate in ascending dimension ID so every fold is independent of any input order.
  const results = new Map<string, DimensionResult>();
  for (const id of [...dimensions.keys()].sort(compareText)) {
    const entry = dimensions.get(id);
    const judgment = byDimension.get(id);
    if (!entry || !judgment) throw new Error('internal: dimension bookkeeping');
    results.set(id, evaluateDimension(state, entry.criterionKey, entry.spec, judgment));
  }

  const aggregated = aggregate(rubric, results, wantsPreview);
  const claimLineages = lineages(state, results);
  const diagnostics = collectDiagnostics(state, results, claimLineages);

  const identity: Omit<RubricIdentity, 'fingerprint'> = {
    source: rubric.source,
    rubricVersion: rubric.rubricVersion,
    contextVersionId: rubric.contextVersionId,
    contextContentHash: rubric.contextContentHash,
    name: rubric.name,
    scope: rubric.scope,
    trackKey: rubric.trackKey,
    weightBasis: rubric.weightBasis,
    needsBasis: rubric.needsBasis,
    scale: { min: rubric.scale.min, max: rubric.scale.max },
    official: rubric.source === 'official_event_context',
  };
  const rubricFingerprint = hashOf(rubric);

  const inputFingerprint = hashOf({
    engineVersion: SCORING_ENGINE_VERSION,
    parametersHash,
    rubric: rubricFingerprint,
    graph: state.graphFingerprint,
    declaredTrackKeys: state.declaredTrackKeys,
    preview: wantsPreview,
    judgments: [...parsed.data.judgments]
      .sort((a, b) => compareText(a.dimensionId, b.dimensionId))
      .map((judgment) => ({
        dimensionId: judgment.dimensionId,
        outcome: judgment.outcome,
        citations: [...judgment.citations].sort((a, b) => compareText(a.evidenceId, b.evidenceId)),
      })),
  });

  const body: ScoreReportBody = {
    engineVersion: SCORING_ENGINE_VERSION,
    parametersHash,
    inputFingerprint,
    graphFingerprint: state.graphFingerprint,
    rubric: { ...identity, fingerprint: rubricFingerprint },
    dimensions: rubric.criteria
      .filter((criterion) => criterion.applicable)
      .flatMap((criterion) => criterion.dimensions)
      .map((spec) => dimensionReport(results.get(spec.id))),
    criteria: aggregated.criteria,
    overall: aggregated.overall,
    unofficialPreview: aggregated.unofficialPreview,
    claimLineages,
    diagnostics,
    notices: {
      contradictionCoverage: 'recorded_only',
      semanticRelevance: 'not_verified',
      claimLabels: 'never_proof_of_truth',
      parameterStatus: 'heuristic_not_calibrated',
      confidenceMeaning: 'index_not_probability',
    },
  };

  // The report must satisfy its own schema (ratios in range, no score on insufficient states, ...).
  // A failure here is an engine defect and fails closed; no partial report is ever returned.
  const outputHash = hashOf(body);
  const checked = ScoreReport.safeParse({ ...body, outputHash });
  if (!checked.success) throw new Error('internal: the score report violates its schema');
  return { ok: true, report: checked.data };
}

// -- Report assembly ---------------------------------------------------------------------------

const ratio = (value: Rational) => roundReported(clampRatio(value));

function dimensionReport(result: DimensionResult | undefined): DimensionReport {
  if (!result) throw new Error('internal: missing dimension result');
  const common = {
    id: result.spec.id,
    criterionKey: result.criterionKey,
    name: result.spec.name,
    weight: result.spec.weight,
    needs:
      result.coverage !== null && result.satisfiedGroups !== null && result.totalGroups !== null
        ? {
            kind: 'declared' as const,
            totalGroups: result.totalGroups,
            satisfiedGroups: result.satisfiedGroups,
            coverage: ratio(result.coverage),
          }
        : { kind: 'unspecified' as const, citationPresence: result.citationPresence ?? 0 },
    citedEvidenceIds: [...result.citedEvidenceIds],
    contradictionIds: [...result.contradictionIds],
    provenanceGroupCount: result.provenanceGroupCount,
  };
  if (result.state === 'assessed' && result.score10 !== null && result.scoreOnScale !== null) {
    return {
      ...common,
      state: 'assessed',
      scoreOnScale: roundReported(result.scoreOnScale),
      score10: roundReported(clamp(result.score10, ZERO, fromInt(10))),
      evidenceStrength: ratio(result.strength),
      strongestEvidenceIds: [...result.strongestEvidenceIds],
      confidenceBasis: result.confidenceBasis,
      confidence: ratio(result.confidence),
    };
  }
  return {
    ...common,
    state: 'insufficient_evidence',
    reason: result.reason ?? 'assessor_reported_insufficient',
    confidence: 0,
  };
}

function collectDiagnostics(
  context: ScoringState,
  results: ReadonlyMap<string, DimensionResult>,
  claimLineages: readonly ClaimLineage[],
): ScoringDiagnostic[] {
  const diagnostics: ScoringDiagnostic[] = [...context.graphDiagnostics];
  // A contradiction recorded on an earlier claim of a chain whose head does not carry it (M4 design F5).
  for (const lineage of claimLineages) {
    const head = context.graph.claims.get(lineage.headClaimId);
    if (lineage.everContradicted && head?.verificationLevel !== 'contradicted') {
      diagnostics.push({
        code: 'LINEAGE_CONTRADICTION_IN_HISTORY',
        path: `claim:${lineage.headClaimId}`,
        entityIds: [...lineage.claimIds],
        message:
          'A claim in this supersession chain was contradicted; the contradiction still counts as uncertainty for the head claim',
      });
    }
  }
  const mappedContradictions = new Set<string>();
  const mappedUnknowns = new Set<string>();
  for (const id of [...results.keys()].sort(compareText)) {
    const result = results.get(id);
    if (!result) continue;
    diagnostics.push(...result.diagnostics);
    for (const contradictionId of result.contradictionIds)
      mappedContradictions.add(contradictionId);
    for (const unknownId of result.mappedUnknownIds) mappedUnknowns.add(unknownId);
  }

  // Recorded contradictions and unknowns that no dimension reached are shown, never dropped.
  const unmappedContradictions = context.graph.ordered.contradictions
    .map((record) => record.id)
    .filter((id) => !mappedContradictions.has(id))
    .sort(compareText);
  if (unmappedContradictions.length > 0) {
    diagnostics.push({
      code: 'UNMAPPED_CONTRADICTION',
      path: 'graph.contradictions',
      entityIds: unmappedContradictions,
      message:
        'Recorded contradictions that touch no evidence cited by any dimension (and no claim related to it); they affect no confidence value but remain open for the judge',
    });
  }
  const unmappedUnknowns = context.graph.ordered.unknowns
    .map((record) => record.id)
    .filter((id) => !mappedUnknowns.has(id))
    .sort(compareText);
  if (unmappedUnknowns.length > 0) {
    diagnostics.push({
      code: 'UNMAPPED_UNKNOWN',
      path: 'graph.unknowns',
      entityIds: unmappedUnknowns,
      message: 'Recorded unknowns that touch no evidence cited by any dimension',
    });
  }

  return diagnostics.sort((a, b) =>
    a.code === b.code
      ? a.path === b.path
        ? compareText(a.entityIds.join(','), b.entityIds.join(','))
        : compareText(a.path, b.path)
      : compareText(a.code, b.code),
  );
}

function lineages(
  context: ScoringState,
  results: ReadonlyMap<string, DimensionResult>,
): ClaimLineage[] {
  const heads = new Map<string, ClaimLineage>();
  for (const result of results.values()) {
    for (const claimId of result.mappedClaimIds) {
      const lineage = lineageOf(context.graph, claimId);
      if (lineage && !heads.has(lineage.headClaimId)) heads.set(lineage.headClaimId, lineage);
    }
  }
  return [...heads.values()].sort((a, b) => compareText(a.headClaimId, b.headClaimId));
}
