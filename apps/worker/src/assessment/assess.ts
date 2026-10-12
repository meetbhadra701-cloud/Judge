import {
  applyPostGates,
  buildAssessorJudgments,
  buildCandidateSets,
  classifyDisposition,
  decideAfterCritic,
  deterministicFlags,
  evaluateRun,
  preGate,
  preGated,
  technicalThreshold,
  trackReferenceAudits,
  validateCritic,
  validateDimensionAssessment,
  withoutCandidates,
  type CriticFinding,
  type FinalUnit,
  type RunEvaluation,
  type UnitCandidates,
  type ValidatedJudgment,
} from '@judge-copilot/assessment';
import {
  AssessmentInputError,
  rescore,
  scorerInputOf,
  scoringContextOf,
  type AssessmentInputReader,
  type AuthorizedAssessmentInputs,
  type JudgmentInput,
  type LedgerEntryLike,
} from '@judge-copilot/database';
import { canonicalJson } from '@judge-copilot/context';
import {
  officialUnitFromLockedSnapshot,
  PromptInputError,
  type UnitView,
} from '@judge-copilot/prompts';
import type { AssessmentRunLimits, ScoreReport } from '@judge-copilot/schemas';
import { variableByteBudget } from './extract.js';
import type { ModelCaller, Validated } from './model-call.js';
import type { RecordingBudget } from './ledger.js';
import { cancelRun, failRun, lostRun } from './stop.js';

/*
 * S8-S13: from the committed extractions to the deterministic M4 report (design §3.2, §5, §9).
 *
 *   S8   the ONLY source of inputs is `AssessmentInputReader.read` (P4): one REPEATABLE READ snapshot that re-verifies the pins, the locked
 *        context hash, the track selections, the committed membership and the provenance of every member. Nothing here builds an input.
 *   S9   the M4 scoring context from those authorized inputs, and the deterministic per-unit candidate sets and pre-gates
 *   S10  one assessor call per unit that can be assessed (sequential), through Zod and gate G6
 *   S11  a SEPARATE critic call on every scored judgment (findings only; the schema has no field that could change a score)
 *   S12  the approved decision table (accept / bounded re-run / mark insufficient / critic unavailable), run-level technical-failure policy
 *   S13  the report, computed by the unchanged M4 engine from the judgments and nothing else (`rescore`), cross-checked against the
 *        P3 builder so two independent constructions of the scorer input must agree
 *
 * Code can only turn a scored judgment into `insufficient_evidence`; it never raises, edits or invents a score. A model failure never
 * yields a score: it yields a unit disposition or ends the run.
 */

export interface AssessContext {
  readonly caller: ModelCaller;
  readonly ledger: RecordingBudget;
  readonly reader: AssessmentInputReader;
  readonly runId: string;
  readonly limits: AssessmentRunLimits;
}

export interface AssessResult {
  readonly authorized: AuthorizedAssessmentInputs;
  readonly units: readonly UnitCandidates[];
  readonly finals: readonly FinalUnit[];
  readonly judgments: readonly JudgmentInput[];
  readonly evaluation: RunEvaluation;
  readonly report: ScoreReport;
  /** Units whose critic reported only minor findings (recorded as a limitation, never as a penalty). */
  readonly minorFindingUnits: readonly string[];
  /** R5 F-7: per unit, the most candidates ever left out of an assessor call because they did not fit its input bound. */
  readonly truncatedCandidates: ReadonlyMap<string, number>;
  readonly rerunsUsed: number;
}

const ASSESSOR_ROLE = 'assessment' as const;

function candidateView(item: UnitCandidates['items'][number]) {
  return {
    handle: item.handle,
    channel: item.channel,
    label: item.label,
    authorship: item.authorship,
    text: item.text,
    excerpt: item.excerpt,
  };
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const points = Array.from(flat);
  return points.length <= 300 ? flat : `${points.slice(0, 299).join('')}…`;
}

export async function readAuthorized(
  reader: AssessmentInputReader,
  runId: string,
): Promise<AuthorizedAssessmentInputs> {
  try {
    return await reader.read(runId);
  } catch (error) {
    if (error instanceof AssessmentInputError) {
      if (error.code === 'context_superseded')
        return cancelRun('context_superseded', 'read_inputs');
      if (error.code === 'run_not_readable' || error.code === 'run_not_found') {
        return lostRun('read_inputs');
      }
      return failRun('internal_error', `inputs_rejected:${error.code}`, 'read_inputs');
    }
    throw error;
  }
}

function technicalCount(finals: readonly FinalUnit[]): number {
  return finals.filter((final) => classifyDisposition(final.disposition) === 'technical').length;
}

export async function assessUnits(context: AssessContext): Promise<AssessResult> {
  const { caller, ledger, reader, runId, limits } = context;
  const encoder = new TextEncoder();
  const bytes = (text: string): number => encoder.encode(text).length;
  const authorized = await readAuthorized(reader, runId);
  const data = authorized.data;

  const scoring = scoringContextOf(authorized);
  if (!scoring.ok) return failRun('internal_error', 'scoring_context_rejected', 'build_context');
  const rubric = scoring.context.rubric;
  if (rubric.source !== 'official_event_context') {
    // The fallback anchors are an unapproved draft (design N12): the renderer refuses them too; this stops the run before any spend.
    return failRun('domain_validation_failed', 'fallback_anchors_not_approved', 'build_context');
  }
  const units = buildCandidateSets({
    graph: data.graph,
    known: data.known,
    rubric,
    declaredTrackKeys: [...data.declaredTrackKeys],
    eventReferences: data.eventReferences,
  });
  if (units.length === 0) return failRun('internal_error', 'rubric_without_units', 'build_context');

  const unitViews = new Map<string, UnitView>();
  for (const unit of units) {
    try {
      unitViews.set(
        unit.dimensionId,
        officialUnitFromLockedSnapshot(
          data.locked,
          {
            versionId: data.locked.versionId,
            lockedContentHash: data.locked.lockedContentHash,
            eventId: data.eventId,
          },
          unit.criterionKey,
        ).unit,
      );
    } catch (error) {
      if (error instanceof PromptInputError)
        return failRun('internal_error', 'unit_view_rejected', 'build_context');
      throw error;
    }
  }

  const scale = rubric.scale;
  const threshold = technicalThreshold(units.length);
  const finals: FinalUnit[] = [];
  const reviewed = new Set<string>();
  const minorFindingUnits: string[] = [];
  const truncatedCandidates = new Map<string, number>();
  let rerunsUsed = 0;

  for (const unit of units) {
    const view = unitViews.get(unit.dimensionId);
    if (!view) return failRun('internal_error', 'unit_view_missing', 'assess_unit');
    const reason = preGate(unit);
    if (reason !== null) {
      finals.push(preGated(unit, reason));
      continue;
    }

    // -- S10-S12 for one unit ------------------------------------------------------------------------------------------------
    const removed = new Set<string>();
    let alreadyRerun = false;
    let final: FinalUnit | null = null;
    while (final === null) {
      const base = removed.size > 0 ? withoutCandidates(unit, [...removed]) : unit;
      // The candidates that fit one call's input bound (the unit's standard counts too). Dropped candidates are not citable.
      const available = Math.floor(0.8 * variableByteBudget(limits)) - bytes(canonicalJson(view));
      if (available < 2_000)
        return failRun('budget_exceeded', 'unit_standard_too_large', 'assess_unit');
      let used = 0;
      const fitted = base.items.filter((item) => {
        const size = bytes(item.text) + bytes(item.excerpt ?? '') + 400;
        if (used + size > available) return false;
        used += size;
        return true;
      });
      const omitted = base.items.length - fitted.length;
      if (omitted > 0) {
        truncatedCandidates.set(
          unit.dimensionId,
          Math.max(truncatedCandidates.get(unit.dimensionId) ?? 0, omitted),
        );
      }
      const active =
        fitted.length === base.items.length
          ? base
          : withoutCandidates(
              base,
              base.items.filter((item) => !fitted.includes(item)).map((item) => item.handle),
            );
      const unitView: UnitView =
        fitted.length === base.items.length || view.notices.includes('sampled_source')
          ? view
          : { ...view, notices: [...view.notices, 'sampled_source'] };
      // S10
      const answer = await caller.call<ValidatedJudgment>({
        stage: 'dimension_assessment',
        role: ASSESSOR_ROLE,
        dimensionId: unit.dimensionId,
        input: { unit: unitView, candidates: active.items.map(candidateView) },
        validate: (json, closed): Validated<ValidatedJudgment> => {
          const staged = validateDimensionAssessment(json, active, scale, closed);
          if (!staged.ok) {
            return staged.phase === 'shape'
              ? { ok: false, phase: 'shape', issues: staged.issues }
              : { ok: false, phase: 'domain' };
          }
          return { ok: true, value: staged.judgment };
        },
      });
      if (answer.kind === 'refused') {
        final = {
          dimensionId: unit.dimensionId,
          disposition: 'provider_refused',
          judgment: null,
          cause: 'refusal',
        };
        break;
      }
      if (answer.kind === 'truncated') {
        final = {
          dimensionId: unit.dimensionId,
          disposition: 'assessor_output_invalid',
          judgment: null,
          cause: 'schema',
        };
        break;
      }
      if (answer.kind === 'invalid') {
        final = {
          dimensionId: unit.dimensionId,
          disposition: 'assessor_output_invalid',
          judgment: null,
          cause: answer.phase === 'shape' ? 'schema' : 'domain',
        };
        break;
      }
      const judgment = answer.value;
      const afterGates = applyPostGates(judgment, active);
      // only a scored judgment can raise a score, so only a scored judgment needs the critic
      if (afterGates.disposition !== 'scored') {
        final = afterGates;
        break;
      }

      // S11: the critic, a separate call with a fresh context, shown the judgment, its cited evidence and the deterministic flags
      const citedHandles = new Set(judgment.citations.map((citation) => citation.handle));
      const cited = active.items.filter((item) => citedHandles.has(item.handle));
      const anchorScores =
        view.standard.basis === 'official' ? view.standard.anchors.map((a) => a.score) : [];
      const flags = deterministicFlags(judgment, active, anchorScores);
      const contradictions = relevantContradictions(authorized, active, cited);
      const verdict = await caller.call<readonly CriticFinding[]>({
        stage: 'critic',
        role: 'critic',
        dimensionId: unit.dimensionId,
        input: {
          unit: unitView,
          judgment: {
            outcome: judgment.outcome,
            rationale: judgment.rationale,
            citations: judgment.citations.map((citation) => ({
              evidence: citation.handle,
              directness: citation.directness,
              specificity: citation.specificity,
              note: citation.note,
            })),
          },
          cited: cited.map(candidateView),
          others: active.items
            .filter((item) => !citedHandles.has(item.handle))
            .map((item) => ({ handle: item.handle, oneLine: oneLine(item.text) })),
          contradictions,
          flags,
        },
        validate: (json, closed): Validated<readonly CriticFinding[]> => {
          const staged = validateCritic(json, closed);
          if (!staged.ok) {
            return staged.phase === 'shape'
              ? { ok: false, phase: 'shape', issues: staged.issues }
              : { ok: false, phase: 'domain' };
          }
          return { ok: true, value: staged.findings };
        },
      });
      if (verdict.kind === 'refused') {
        final = {
          dimensionId: unit.dimensionId,
          disposition: 'provider_refused',
          judgment,
          cause: 'refusal',
        };
        break;
      }
      const findings = verdict.kind === 'ok' ? verdict.value : null;
      const decision = decideAfterCritic({
        findings,
        citedHandles,
        alreadyRerun,
        runRerunsUsed: rerunsUsed,
        rubric: 'official',
      });
      if (decision.action === 'accept') {
        reviewed.add(unit.dimensionId);
        if (decision.minor.length > 0) minorFindingUnits.push(unit.dimensionId);
        final = afterGates;
      } else if (decision.action === 'rerun') {
        // The re-run is told nothing the critic wrote (P2 has no feedback channel and prose must not reach a later prompt); an
        // injection finding removes the suspected evidence from what the assessor may cite.
        rerunsUsed += 1;
        alreadyRerun = true;
        for (const handle of decision.removeFromCandidates) removed.add(handle);
        const left = removed.size > 0 ? withoutCandidates(unit, [...removed]) : unit;
        if (left.items.every((item) => !item.projectDerived)) {
          reviewed.add(unit.dimensionId);
          final = {
            dimensionId: unit.dimensionId,
            disposition: 'marked_insufficient_by_critic',
            judgment,
          };
        }
      } else if (decision.action === 'mark_insufficient') {
        reviewed.add(unit.dimensionId);
        final = {
          dimensionId: unit.dimensionId,
          disposition: decision.disposition,
          judgment,
        };
      } else {
        // the critic's answer stayed invalid: an unreviewed judgment is never accepted
        final = {
          dimensionId: unit.dimensionId,
          disposition: decision.disposition,
          judgment,
          cause: verdict.kind === 'invalid' && verdict.phase === 'domain' ? 'domain' : 'schema',
        };
      }
    }
    finals.push(final);
    // Once the technical threshold is reached the run fails whatever the remaining units do: stop spending (design §9.3)
    if (technicalCount(finals) >= threshold) {
      return failRun(
        technicalCategory(finals),
        'technical_failures_over_threshold',
        'assess_units',
      );
    }
  }

  const evaluation = evaluateRun(finals);
  if (evaluation.failRun) {
    return failRun(
      evaluation.failureCategory ?? 'domain_validation_failed',
      evaluation.allTechnical ? 'all_units_technical' : 'technical_failures_over_threshold',
      'assess_units',
    );
  }

  // -- S13: the judgment records, and the report from the unchanged engine ---------------------------------------------------------
  const rows = await ledger.ledgerRows();
  const audits = trackReferenceAudits(units, finals);
  const judgments = finals.map((final) =>
    toJudgmentInput(
      final,
      rows,
      reviewed.has(final.dimensionId),
      audits.some((a) => a.dimensionId === final.dimensionId),
    ),
  );
  const built = buildAssessorJudgments(finals, rubric);
  const stored = scorerInputOf(judgments);
  if (!built.ok || !stored.ok || canonicalJson(built.input) !== canonicalJson(stored.input)) {
    // two independent constructions of the scorer input must agree
    return failRun('internal_error', 'scorer_input_mismatch', 'score');
  }
  const scored = rescore(authorized, judgments);
  if (!scored.ok) return failRun('internal_error', `scoring_failed:${scored.stage}`, 'score');
  return {
    authorized,
    units,
    finals,
    judgments,
    evaluation,
    report: scored.report,
    minorFindingUnits,
    truncatedCandidates,
    rerunsUsed,
  };
}

/** "schema when most of the technical failures were schema failures, otherwise domain" (design §9.3). */
function technicalCategory(finals: readonly FinalUnit[]) {
  let schema = 0;
  let other = 0;
  for (const final of finals) {
    if (classifyDisposition(final.disposition) !== 'technical') continue;
    if (final.cause === 'schema') schema += 1;
    else other += 1;
  }
  return schema > other
    ? ('schema_validation_failed' as const)
    : ('domain_validation_failed' as const);
}

/** The recorded contradictions that touch what the judgment cited (a side that is cited evidence, or a claim related to it). */
function relevantContradictions(
  authorized: AuthorizedAssessmentInputs,
  unit: UnitCandidates,
  cited: UnitCandidates['items'],
): { description: string; sideA: string; sideB: string }[] {
  const graph = authorized.data.graph.ordered;
  const handleOfEvidence = new Map(unit.items.map((item) => [item.evidenceId, item.handle]));
  const citedIds = new Set(cited.map((item) => item.evidenceId));
  const claimIds = new Map(graph.claims.map((claim, index) => [claim.id, index + 1]));
  const relatedClaims = new Set(
    graph.relations.filter((r) => citedIds.has(r.evidenceId)).map((r) => r.claimId),
  );
  const handleOf = (side: { type: string; id: string }): string | null => {
    if (side.type === 'claim') {
      const n = claimIds.get(side.id);
      return n === undefined ? null : `C-${String(n).padStart(3, '0')}`;
    }
    return handleOfEvidence.get(side.id) ?? null;
  };
  const out: { description: string; sideA: string; sideB: string }[] = [];
  for (const contradiction of graph.contradictions) {
    const touches = [contradiction.sideA, contradiction.sideB].some(
      (side) =>
        (side.type === 'evidence' && citedIds.has(side.id)) ||
        (side.type === 'claim' && relatedClaims.has(side.id)),
    );
    const a = handleOf(contradiction.sideA);
    const b = handleOf(contradiction.sideB);
    if (touches && a !== null && b !== null) {
      out.push({ description: contradiction.description, sideA: a, sideB: b });
    }
    if (out.length >= 20) break;
  }
  return out;
}

/** The persisted record of one unit: exactly what the scorer was handed (citations kept only where `buildAssessorJudgments` keeps them). */
function toJudgmentInput(
  final: FinalUnit,
  rows: readonly LedgerEntryLike[],
  criticReviewed: boolean,
  reviewRequired: boolean,
): JudgmentInput {
  const scored = final.disposition === 'scored' && final.judgment?.outcome.kind === 'scored';
  const keepsJudgment =
    final.disposition === 'scored' || final.disposition === 'assessor_reported_insufficient';
  const seqsOf = (stage: 'dimension_assessment' | 'critic'): number[] =>
    rows
      .filter((row) => row.stage === stage && row.dimensionId === final.dimensionId)
      .map((row) => row.callId)
      .sort((a, b) => a - b);
  const assessorSeqs = seqsOf('dimension_assessment');
  const criticSeqs = seqsOf('critic');
  const judgment = keepsJudgment ? final.judgment : null;
  return {
    dimensionId: final.dimensionId,
    outcomeKind: scored ? 'scored' : 'insufficient_evidence',
    score:
      final.judgment?.outcome.kind === 'scored' && scored ? final.judgment.outcome.score : null,
    disposition: final.disposition,
    rationale: judgment?.rationale ?? null,
    limitations: judgment ? [...judgment.limitations] : [],
    assessorAttempts: assessorSeqs.length,
    criticAttempts: criticSeqs.length,
    assessorCallSeqs: assessorSeqs,
    criticCallSeqs: criticSeqs,
    criticReviewRequired: reviewRequired,
    criticReviewed: criticReviewed && criticSeqs.length > 0,
    citations: judgment
      ? judgment.citations.map((citation) => ({
          evidenceId: citation.evidenceId,
          directness: citation.directness,
          specificity: citation.specificity,
          note: citation.note,
        }))
      : [],
  };
}
