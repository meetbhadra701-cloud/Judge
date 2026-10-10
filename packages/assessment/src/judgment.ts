import {
  AssessorJudgmentsInput,
  SCORING_ENGINE_VERSION,
  type DimensionAssessmentOutput,
  type DimensionJudgment,
  type DimensionLimitationCode,
  type EvidenceChannel,
  type EvidenceDirectness,
  type EvidenceSpecificity,
} from '@judge-copilot/schemas';
import type { RubricSpec } from '@judge-copilot/scoring';
import {
  requiredReferenceKinds,
  type CandidateItem,
  type PreGateReason,
  type UnitCandidates,
} from './candidates.js';
import { shownHandles, shownUnit, type ClosedSet } from './closed-set.js';
import type { EventReferenceApplicability } from './event-evidence.js';
import { issue, type DomainIssue } from './issues.js';

/*
 * Gate G6 and the deterministic post-gates (design §5.2-§5.3, §4.7, §9.3).
 *
 * A dimension judgment may cite only evidence actually SHOWN for that unit. Code resolves the handles to persisted ids; the model
 * never supplies an id. The model produces no total, weight, confidence, strength or overall score: of its answer only
 * `dimensionId`, the outcome and `{evidenceId, directness, specificity}` per citation reach the scorer; the rationale, notes and
 * limitation codes are kept for the judge.
 *
 * Code may alter a judgment in exactly one direction: scored -> insufficient_evidence, with the reason recorded. It never raises or
 * edits a score.
 */

export interface ValidatedCitation {
  readonly handle: string;
  readonly evidenceId: string;
  readonly directness: EvidenceDirectness;
  readonly specificity: EvidenceSpecificity;
  readonly note: string;
}

export interface ValidatedJudgment {
  readonly dimensionId: string;
  readonly outcome: DimensionAssessmentOutput['outcome'];
  readonly citations: readonly ValidatedCitation[];
  readonly rationale: string;
  readonly limitations: readonly DimensionLimitationCode[];
}

export type JudgmentGateResult =
  | { readonly ok: true; readonly judgment: ValidatedJudgment }
  | { readonly ok: false; readonly issues: readonly DomainIssue[] };

/**
 * G6. `scale` is the rubric's published scale for the unit. `shown` is the closed set of THIS assessor call (the evidence handles and
 * the unit its prompt showed): a candidate that is in `unit` but was not in the prompt (for example one removed for a re-run) is not
 * citable, and the judgment must be about the unit the prompt asked about.
 */
export function gateJudgment(
  output: DimensionAssessmentOutput,
  unit: UnitCandidates,
  scale: { readonly min: number; readonly max: number },
  shown: Pick<ClosedSet, 'evidence' | 'unit'>,
): JudgmentGateResult {
  const shownEvidence = shownHandles(shown, 'evidence');
  const shownDimension = shownUnit(shown);
  const issues: DomainIssue[] = [];
  const add = (code: string, path: string, handle?: string) =>
    issues.push(issue('G6', code, path, handle));

  if (output.dimensionId !== unit.dimensionId || output.dimensionId !== shownDimension) {
    add('wrong_dimension', 'dimensionId');
  }
  if (output.outcome.kind === 'scored') {
    const { score } = output.outcome;
    if (!Number.isFinite(score)) add('score_not_finite', 'outcome.score');
    else if (score < scale.min || score > scale.max) add('score_out_of_scale', 'outcome.score');
    if (output.citations.length === 0) add('scored_without_citation', 'citations');
  }

  const seen = new Set<string>();
  const citations: ValidatedCitation[] = [];
  output.citations.forEach((citation, index) => {
    const path = `citations[${String(index)}].evidence`;
    const item = unit.byHandle.get(citation.evidence);
    if (!item) {
      add('unknown_citation_handle', path, citation.evidence);
      return;
    }
    if (!shownEvidence.has(citation.evidence)) {
      add('citation_not_shown', path, citation.evidence);
      return;
    }
    if (seen.has(citation.evidence)) {
      add('duplicate_citation', path, citation.evidence);
      return;
    }
    seen.add(citation.evidence);
    // Event rules describe what the EVENT requires, never what the project does: only as indirect, generic context (§4.7).
    if (
      item.authorship === 'event_reference' &&
      (citation.directness !== 'indirect' || citation.specificity !== 'generic')
    ) {
      add('event_reference_classification', `citations[${String(index)}]`, citation.evidence);
      return;
    }
    citations.push({
      handle: citation.evidence,
      evidenceId: item.evidenceId,
      directness: citation.directness,
      specificity: citation.specificity,
      note: citation.note,
    });
  });
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    judgment: {
      dimensionId: output.dimensionId,
      outcome: output.outcome,
      citations,
      rationale: output.rationale,
      limitations: output.limitations,
    },
  };
}

// -- Track reference audit (R3 A4) ----------------------------------------------------------------------------------------

/**
 * What a later semantic-relevance review needs for ONE scored Track judgment, retained verbatim from code-authored data. The P3 gate
 * is STRUCTURAL: it proves the judgment cites an applicable reference of the right KIND for the declared track, not that the cited
 * rule is relevant to the dimension ("Do not harass event staff" is a structurally applicable overall rule that says nothing about a
 * required technology). So every such judgment carries `semanticRelevance: 'not_verified'` and `criticReviewRequired: true`, and P5 may
 * not accept the assessment until a critic review of exactly these citations has completed.
 */
export interface TrackReferenceAudit {
  readonly dimensionId: string;
  readonly semanticRelevance: 'not_verified';
  readonly criticReviewRequired: true;
  readonly references: readonly {
    readonly handle: string;
    readonly evidenceId: string;
    readonly applicability: EventReferenceApplicability;
    readonly trackKey: string | null;
    readonly directness: EvidenceDirectness;
    readonly specificity: EvidenceSpecificity;
  }[];
}

/** One audit per SCORED fallback Track judgment, in unit order. Empty when none was scored. */
export function trackReferenceAudits(
  units: readonly UnitCandidates[],
  finals: readonly FinalUnit[],
): TrackReferenceAudit[] {
  const audits: TrackReferenceAudit[] = [];
  for (const final of finals) {
    if (final.disposition !== 'scored' || final.judgment === null) continue;
    if (requiredReferenceKinds(final.dimensionId) === null) continue;
    const unit = units.find((candidate) => candidate.dimensionId === final.dimensionId);
    if (!unit) continue;
    const references = final.judgment.citations.flatMap((citation) => {
      const item = unit.byHandle.get(citation.handle);
      return item?.reference
        ? [
            {
              handle: citation.handle,
              evidenceId: item.evidenceId,
              applicability: item.reference.applicability,
              trackKey: item.reference.trackKey,
              directness: citation.directness,
              specificity: citation.specificity,
            },
          ]
        : [];
    });
    audits.push({
      dimensionId: final.dimensionId,
      semanticRelevance: 'not_verified',
      criticReviewRequired: true,
      references,
    });
  }
  return audits;
}

// -- Dispositions ---------------------------------------------------------------------------------------------------------

export const UNIT_DISPOSITION_VALUES = [
  'scored',
  // valid insufficiency: a successful, honest outcome
  'assessor_reported_insufficient',
  'no_candidate_evidence',
  'no_satisfiable_need',
  'no_official_requirement_available',
  'event_reference_only',
  'no_project_derived_citation',
  'no_applicable_context_cited',
  'no_declared_need_satisfied',
  // substantive: the pipeline worked and judged the support inadequate
  'marked_insufficient_by_critic',
  // technical: the machinery misbehaved
  'assessor_output_invalid',
  'critic_unavailable',
  'provider_refused',
  'official_requirement_omitted_by_limit',
] as const;
export type UnitDisposition = (typeof UNIT_DISPOSITION_VALUES)[number];

export type DispositionClass = 'scored' | 'valid_insufficiency' | 'substantive' | 'technical';

export function classifyDisposition(disposition: UnitDisposition): DispositionClass {
  switch (disposition) {
    case 'scored':
      return 'scored';
    case 'marked_insufficient_by_critic':
      return 'substantive';
    case 'assessor_output_invalid':
    case 'critic_unavailable':
    case 'provider_refused':
    case 'official_requirement_omitted_by_limit':
      return 'technical';
    default:
      return 'valid_insufficiency';
  }
}

export interface FinalUnit {
  readonly dimensionId: string;
  readonly disposition: UnitDisposition;
  /** The validated judgment the disposition rests on (null when no model judgment survived). */
  readonly judgment: ValidatedJudgment | null;
  /** For technical dispositions: whether the failure was a schema failure, a domain failure or a refusal. */
  readonly cause?: 'schema' | 'domain' | 'refusal';
}

/** A unit that was never sent to the model because a pre-gate decided. */
export function preGated(unit: UnitCandidates, reason: PreGateReason): FinalUnit {
  return { dimensionId: unit.dimensionId, disposition: reason, judgment: null };
}

/**
 * Post-gates on a validated, SCORED judgment (design §4.7, §5.3). They only ever turn it into `insufficient_evidence`:
 *   - every citation is an Event-Context reference            -> event_reference_only
 *   - fallback Track unit without a project-derived citation  -> no_project_derived_citation
 *   - fallback Track unit citing no APPLICABLE official context -> no_applicable_context_cited  (review F2)
 *   - fallback unit whose cited channels satisfy no declared need -> no_declared_need_satisfied  (decision N4)
 */
export function applyPostGates(judgment: ValidatedJudgment, unit: UnitCandidates): FinalUnit {
  if (judgment.outcome.kind !== 'scored') {
    return {
      dimensionId: unit.dimensionId,
      disposition: 'assessor_reported_insufficient',
      judgment,
    };
  }
  const cited = judgment.citations
    .map((citation) => unit.byHandle.get(citation.handle))
    .filter((item): item is CandidateItem => item !== undefined);
  const downgrade = (disposition: UnitDisposition): FinalUnit => ({
    dimensionId: unit.dimensionId,
    disposition,
    judgment,
  });
  if (cited.length > 0 && cited.every((item) => !item.projectDerived))
    return downgrade('event_reference_only');
  const required = requiredReferenceKinds(unit.dimensionId);
  if (required !== null) {
    // A Track judgment must cite BOTH project-derived evidence AND applicable official context. Applicability comes from the
    // code-authored metadata of the cited item, never from what the model says about it.
    if (!cited.some((item) => item.projectDerived)) return downgrade('no_project_derived_citation');
    if (
      !cited.some(
        (item) => item.reference !== null && required.includes(item.reference.applicability),
      )
    ) {
      return downgrade('no_applicable_context_cited');
    }
  }
  if (unit.needGroups !== null) {
    const channels = new Set<EvidenceChannel>(cited.map((item) => item.channel));
    if (!unit.needGroups.some((group) => group.some((channel) => channels.has(channel)))) {
      return downgrade('no_declared_need_satisfied');
    }
  }
  return { dimensionId: unit.dimensionId, disposition: 'scored', judgment };
}

// -- Deterministic flags for the critic ---------------------------------------------------------------------------------

export const CRITIC_FLAG_CODES = [
  'raw_signal_terms',
  'score_outside_anchor_bracket',
  'all_citations_weak',
  'rationale_mentions_uncited_handle',
  'only_team_authored_evidence',
] as const;
export type CriticFlag = (typeof CRITIC_FLAG_CODES)[number];

const RAW_SIGNAL =
  /\b(?:commits?|lines? of code|loc|stars?|contributors?|file counts?|number of files|dependenc(?:y|ies) counts?|keyword(?:s| frequency| counts?)?)\b/iu;

/** Checks the model cannot waive; they are passed to the critic as facts (design §9.2). `anchorScores` is empty for a unit without anchors. */
export function deterministicFlags(
  judgment: ValidatedJudgment,
  unit: UnitCandidates,
  anchorScores: readonly number[],
): CriticFlag[] {
  const flags: CriticFlag[] = [];
  const text = `${judgment.rationale}\n${judgment.citations.map((c) => c.note).join('\n')}`;
  if (RAW_SIGNAL.test(text)) flags.push('raw_signal_terms');
  if (judgment.outcome.kind === 'scored' && anchorScores.length > 0) {
    const { score } = judgment.outcome;
    if (score < Math.min(...anchorScores) || score > Math.max(...anchorScores))
      flags.push('score_outside_anchor_bracket');
  }
  if (
    judgment.outcome.kind === 'scored' &&
    judgment.citations.length > 0 &&
    judgment.citations.every((c) => c.directness === 'indirect' || c.specificity === 'generic')
  ) {
    flags.push('all_citations_weak');
  }
  const cited = new Set(judgment.citations.map((c) => c.handle));
  const mentioned = judgment.rationale.match(/\bE-\d{3,5}\b/g) ?? [];
  if (mentioned.some((handle) => !cited.has(handle)))
    flags.push('rationale_mentions_uncited_handle');
  const items = judgment.citations
    .map((c) => unit.byHandle.get(c.handle))
    .filter((item): item is CandidateItem => item !== undefined);
  if (items.length > 0 && items.every((item) => item.authorship === 'team_statement')) {
    flags.push('only_team_authored_evidence');
  }
  return flags;
}

// -- The exact input the M4 scorer expects ------------------------------------------------------------------------------

/**
 * Builds `AssessorJudgmentsInput` from the final units. Of each judgment ONLY the dimension id, the outcome and the classified
 * citations are passed (rationale, notes and limitation codes are M5-only and are stripped). Every applicable dimension of the
 * rubric must have exactly one unit; the result is validated with M4's own strict schema.
 */
export function buildAssessorJudgments(
  units: readonly FinalUnit[],
  rubric: RubricSpec,
):
  | { readonly ok: true; readonly input: AssessorJudgmentsInput }
  | { readonly ok: false; readonly issues: readonly DomainIssue[] } {
  const issues: DomainIssue[] = [];
  const expected = rubric.criteria
    .filter((criterion) => criterion.applicable)
    .flatMap((criterion) => criterion.dimensions.map((dimension) => dimension.id));
  const byId = new Map<string, FinalUnit>();
  for (const unit of units) {
    if (byId.has(unit.dimensionId))
      issues.push(issue('G6', 'duplicate_unit', 'units', unit.dimensionId));
    byId.set(unit.dimensionId, unit);
  }
  for (const id of expected) {
    if (!byId.has(id)) issues.push(issue('G6', 'unit_missing', `units.${id}`));
  }
  for (const id of byId.keys()) {
    if (!expected.includes(id)) issues.push(issue('G6', 'unit_not_in_rubric', `units.${id}`));
  }
  if (issues.length > 0) return { ok: false, issues };

  const judgments: DimensionJudgment[] = [...expected].sort().map((id) => {
    const unit = byId.get(id);
    if (!unit) throw new Error('internal: unit bookkeeping');
    if (unit.disposition === 'scored' && unit.judgment?.outcome.kind === 'scored') {
      return {
        dimensionId: id,
        outcome: { kind: 'scored' as const, score: unit.judgment.outcome.score },
        citations: [...unit.judgment.citations]
          .sort((a, b) => (a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0))
          .map(({ evidenceId, directness, specificity }) => ({
            evidenceId,
            directness,
            specificity,
          })),
      };
    }
    // Anything that is not a surviving scored judgment is insufficient_evidence. Only the assessor's own report keeps its citations.
    const kept = unit.disposition === 'assessor_reported_insufficient' ? unit.judgment : null;
    return {
      dimensionId: id,
      outcome: { kind: 'insufficient_evidence' as const },
      citations: kept
        ? [...kept.citations]
            .sort((a, b) =>
              a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0,
            )
            .map(({ evidenceId, directness, specificity }) => ({
              evidenceId,
              directness,
              specificity,
            }))
        : [],
    };
  });
  const parsed = AssessorJudgmentsInput.safeParse({
    engineVersion: SCORING_ENGINE_VERSION,
    judgments,
  });
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues
        .slice(0, 20)
        .map((entry) => issue('G6', entry.code, entry.path.join('.'))),
    };
  }
  return { ok: true, input: parsed.data };
}
