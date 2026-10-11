import { storedFormOf, UNIT_DISPOSITION_VALUES } from '@judge-copilot/assessment';
import { canonicalJson } from '@judge-copilot/context';
import {
  AssessorJudgmentsInput,
  ASSESSMENT_OUTPUT_LIMITS,
  DIMENSION_LIMITATION_CODE_VALUES,
  EVIDENCE_DIRECTNESS_VALUES,
  EVIDENCE_SPECIFICITY_VALUES,
  SCORING_ENGINE_VERSION,
  type ScoreReport,
} from '@judge-copilot/schemas';
import {
  createTrustedScoringContext,
  scoreProject,
  type TrustedScoringContext,
} from '@judge-copilot/scoring';
import type { AuthorizedAssessmentInputs } from './assessment-input-reader.js';
import type { JudgmentInput } from './assessment-store.js';

/*
 * The trusted recomputation boundary of persistence (R4 F1/F2). `verifyStoredAssessment` proves that a report is internally
 * consistent (its bytes, its schema, its own hash). It proves nothing about WHICH inputs the report was computed from. This module
 * closes that gap with the real, unchanged M4 engine:
 *
 *   1. the scorer's only untrusted input, `AssessorJudgmentsInput`, is reconstructed from the judgments being stored. A judgment row
 *      stores exactly what the scorer was handed: its outcome, its score and the classified citations (evidence id, directness,
 *      specificity). The rationale, notes and limitation codes are M5-only and are not scorer inputs; they are validated separately
 *      as vocabulary and consistency (`validateJudgmentRecords`), never as claims about the truth of the prose;
 *   2. the trusted scoring context is built from the database-authorized inputs only (`AuthorizedAssessmentInputs`): the pinned locked
 *      document, the declared tracks, the scoping target and the verified, scoped graph. The rubric is selected by M4 from those, never
 *      by the report;
 *   3. `scoreProject` runs and its report must equal the supplied report byte for byte (canonical JSON, `outputHash` included).
 *
 * No weight, formula, rounding, constant or engine version is touched here: this file only calls the engine.
 */

/** Dispositions whose stored citations are the citations the scorer received (see `buildAssessorJudgments`). */
const DISPOSITIONS_KEEPING_CITATIONS: ReadonlySet<string> = new Set([
  'scored',
  'assessor_reported_insufficient',
]);

export type JudgmentRecordIssueCode =
  | 'duplicate_dimension'
  | 'unknown_disposition'
  | 'outcome_disposition_mismatch'
  | 'score_not_finite'
  | 'citations_not_allowed'
  | 'duplicate_citation'
  | 'unknown_classification'
  | 'text_too_long'
  | 'unknown_limitation'
  | 'attempts_inconsistent';

export interface JudgmentRecordIssue {
  readonly code: JudgmentRecordIssueCode;
  readonly dimensionId: string;
}

/**
 * M5-only vocabulary and consistency of the judgment records (R4 F1: "validate their allowed vocabulary and consistency
 * separately, without pretending the scorer verifies prose truth"). Pure; checks nothing the scorer decides.
 */
export function validateJudgmentRecords(
  judgments: readonly JudgmentInput[],
): readonly JudgmentRecordIssue[] {
  const issues: JudgmentRecordIssue[] = [];
  const seen = new Set<string>();
  const dispositions: readonly string[] = UNIT_DISPOSITION_VALUES;
  const limitations: readonly string[] = DIMENSION_LIMITATION_CODE_VALUES;
  const directness: readonly string[] = EVIDENCE_DIRECTNESS_VALUES;
  const specificity: readonly string[] = EVIDENCE_SPECIFICITY_VALUES;
  for (const judgment of judgments) {
    const id = judgment.dimensionId;
    const add = (code: JudgmentRecordIssueCode) => issues.push({ code, dimensionId: id });
    if (seen.has(id)) add('duplicate_dimension');
    seen.add(id);
    if (!dispositions.includes(judgment.disposition)) add('unknown_disposition');
    // a scored judgment is exactly a scored disposition; everything else is insufficient evidence with no score
    const scored = judgment.outcomeKind === 'scored';
    if (scored !== (judgment.disposition === 'scored') || scored !== (judgment.score !== null)) {
      add('outcome_disposition_mismatch');
    }
    if (judgment.score !== null && !Number.isFinite(judgment.score)) add('score_not_finite');
    if (
      judgment.citations.length > 0 &&
      !DISPOSITIONS_KEEPING_CITATIONS.has(judgment.disposition)
    ) {
      add('citations_not_allowed');
    }
    const cited = new Set<string>();
    for (const citation of judgment.citations) {
      if (cited.has(citation.evidenceId)) add('duplicate_citation');
      cited.add(citation.evidenceId);
      if (
        !directness.includes(citation.directness) ||
        !specificity.includes(citation.specificity)
      ) {
        add('unknown_classification');
      }
      if ((citation.note ?? '').length > ASSESSMENT_OUTPUT_LIMITS.noteMaxChars)
        add('text_too_long');
    }
    if ((judgment.rationale ?? '').length > ASSESSMENT_OUTPUT_LIMITS.rationaleMaxChars) {
      add('text_too_long');
    }
    if (
      judgment.limitations.length > ASSESSMENT_OUTPUT_LIMITS.limitationsPerUnit ||
      judgment.limitations.some((code) => !limitations.includes(code))
    ) {
      add('unknown_limitation');
    }
    if (
      judgment.assessorAttempts !== judgment.assessorCallSeqs.length ||
      judgment.criticAttempts !== judgment.criticCallSeqs.length
    ) {
      add('attempts_inconsistent');
    }
  }
  return issues;
}

export type ScorerInputResult =
  | { readonly ok: true; readonly input: AssessorJudgmentsInput }
  | { readonly ok: false; readonly issues: readonly string[] };

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The exact `AssessorJudgmentsInput` the judgment records stand for: dimensions in id order, citations in evidence-id order, only the
 * dimension id, the outcome and the classified citations (the rule of `buildAssessorJudgments`). Validated with M4's own strict schema.
 */
export function scorerInputOf(judgments: readonly JudgmentInput[]): ScorerInputResult {
  const candidate = {
    engineVersion: SCORING_ENGINE_VERSION,
    judgments: [...judgments]
      .sort((a, b) => byText(a.dimensionId, b.dimensionId))
      .map((judgment) => ({
        dimensionId: judgment.dimensionId,
        outcome:
          judgment.outcomeKind === 'scored'
            ? { kind: 'scored' as const, score: judgment.score }
            : { kind: 'insufficient_evidence' as const },
        citations: [...judgment.citations]
          .sort((a, b) => byText(a.evidenceId, b.evidenceId))
          .map(({ evidenceId, directness, specificity }) => ({
            evidenceId,
            directness,
            specificity,
          })),
      })),
  };
  const parsed = AssessorJudgmentsInput.safeParse(candidate);
  if (!parsed.success) {
    // paths and codes only: never the offending value
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.')}:${i.code}`),
    };
  }
  return { ok: true, input: parsed.data };
}

/** The trusted M4 scoring context of the authorized inputs. The target, the tracks, the document and the graph are the run's. */
export function scoringContextOf(
  authorized: AuthorizedAssessmentInputs,
):
  | { readonly ok: true; readonly context: TrustedScoringContext }
  | { readonly ok: false; readonly issues: readonly string[] } {
  const data = authorized.data;
  const created = createTrustedScoringContext({
    projectId: data.projectId,
    eventId: data.eventId,
    graph: data.graph,
    known: data.known,
    locked: data.locked,
    target:
      data.target.kind === 'overall'
        ? { kind: 'overall' }
        : { kind: 'track', trackKey: data.target.trackKey ?? '' },
    declaredTrackKeys: [...data.declaredTrackKeys],
  });
  if (!created.ok) {
    return { ok: false, issues: created.issues.slice(0, 20).map((i) => `${i.code}@${i.path}`) };
  }
  return { ok: true, context: created.context };
}

export type RescoreResult =
  | { readonly ok: true; readonly report: ScoreReport }
  | {
      readonly ok: false;
      readonly stage: 'scoring_context' | 'scorer_input' | 'scoring';
      readonly issues: readonly string[];
    };

/** Re-runs the real M4 engine over the authorized inputs and the judgments to be stored. */
export function rescore(
  authorized: AuthorizedAssessmentInputs,
  judgments: readonly JudgmentInput[],
): RescoreResult {
  const input = scorerInputOf(judgments);
  if (!input.ok) return { ok: false, stage: 'scorer_input', issues: input.issues };
  const context = scoringContextOf(authorized);
  if (!context.ok) return { ok: false, stage: 'scoring_context', issues: context.issues };
  const result = scoreProject(context.context, input.input);
  if (!result.ok) {
    return {
      ok: false,
      stage: 'scoring',
      issues: result.issues.slice(0, 20).map((i) => `${i.code}@${i.path}`),
    };
  }
  return { ok: true, report: result.report };
}

/** The parts of a report that differ from the recomputed one, by NAME (never by content). Empty means byte-identical. */
export function reportDifferences(expected: ScoreReport, supplied: ScoreReport): string[] {
  if (canonicalJson(expected) === canonicalJson(supplied)) return [];
  const differences: string[] = [];
  const expectedRecord = expected as unknown as Record<string, unknown>;
  const suppliedRecord = supplied as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(expectedRecord), ...Object.keys(suppliedRecord)])) {
    if (canonicalJson(expectedRecord[key]) !== canonicalJson(suppliedRecord[key])) {
      differences.push(key);
    }
  }
  // the identity parts of the rubric are named separately: they are the first thing a foreign report differs in
  const expectedRubric = expected.rubric as unknown as Record<string, unknown>;
  const suppliedRubric = supplied.rubric as unknown as Record<string, unknown>;
  for (const key of Object.keys(expectedRubric)) {
    if (canonicalJson(expectedRubric[key]) !== canonicalJson(suppliedRubric[key])) {
      differences.push(`rubric.${key}`);
    }
  }
  return differences.length > 0 ? differences : ['report'];
}

/** The canonical bytes of the recomputed report: what the stored text must equal. */
export const canonicalReportText = (report: ScoreReport): string =>
  storedFormOf(report).reportCanonical;
