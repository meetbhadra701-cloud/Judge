import type {
  Distinguishing,
  Effort,
  QuestionMode,
  UncertaintyKind,
  UncertaintySeverity,
} from '@judge-copilot/schemas';
import type { UncertaintyOpportunity } from '@judge-copilot/uncertainty';
import type { ValidatedCandidate } from './validate.js';

/*
 * THE RANKING MODEL of question-engine/v1. It is an explicit, testable ordering rule, not a statistical model: the value it produces is an INFORMATION-GAIN
 * HEURISTIC in basis points, ordered but never calibrated, and it is never a probability (invariant 13 applies to every number of this family). Nothing
 * here reads a score and nothing here can change a score or a weight: the official rubric weights enter only as the share of the rubric a dimension
 * carries, which orders opportunities.
 *
 *   value(q) = R × S × D × (0.5 + 0.5·O) ÷ (1 + C)                      each factor in [0, 1]; the result is scaled to basis points (×10 000)
 *
 *   R  decision relevance      noisy-or over the question's opportunities:  1 − Π (1 − relevance(o)).  relevance(o) is the share of the OFFICIAL rubric the
 *                              opportunity's dimensions carry; an opportunity with no scored dimension (a track requirement, a track rubric) uses a fixed floor.
 *   S  severity                the largest severity among the opportunities (critical 1.00, high 0.75, moderate 0.50, low 0.25).
 *   D  distinguishing power    how well an answer can tell the competing interpretations apart: the model's PROPOSAL (weak .4 / moderate .7 / strong 1.0)
 *                              capped by this table's ceiling for the opportunity's kind. A proposal can lower D, never raise it above the ceiling.
 *   O  observability           whether the question asks for something the judge can SEE (demonstrate 1.0 … ask .3). An observable request outranks a
 *                              verbal assurance of the same value.
 *   C  interview cost          time and effort: the larger of the mode's floor and the model's proposed effort (brief .1 / moderate .3 / extended .6).
 *
 * Selection (select.ts) is greedy by MARGINAL value: the value of a candidate times its novelty against what is already selected, so five questions about
 * one feature cannot all be chosen. Ties are broken by a total order that ends in the candidate key, so identical inputs always give identical output.
 */

export const RANKING = {
  /** Fixed relevance floors (thousandths) for an opportunity that bears on no scored dimension. */
  floors: {
    requirementTrack: 500,
    requirementOverall: 250,
    trackRubric: 500,
    unattributed: 200,
  },
  severityMilli: { critical: 1000, high: 750, moderate: 500, low: 250 } as Readonly<
    Record<UncertaintySeverity, number>
  >,
  /** The ceiling (thousandths) of distinguishing power for each kind of uncertainty. */
  distinguishingCeilingMilli: {
    contradiction_recorded: 1000,
    dimension_not_assessed: 900,
    claim_unverified: 900,
    dimension_rests_on_claims: 850,
    requirement_unaddressed: 800,
    coverage_partial: 700,
    source_missing: 700,
    track_rubric_not_assessed: 600,
    unknown_recorded: 600,
    thin_evidence: 500,
  } as Readonly<Record<UncertaintyKind, number>>,
  proposalMilli: { weak: 400, moderate: 700, strong: 1000 } as Readonly<
    Record<Distinguishing, number>
  >,
  observabilityMilli: {
    demonstrate: 1000,
    show_me: 900,
    verify: 850,
    clarify: 400,
    ask: 300,
  } as Readonly<Record<QuestionMode, number>>,
  modeCostMilli: {
    ask: 100,
    clarify: 150,
    show_me: 300,
    verify: 350,
    demonstrate: 500,
  } as Readonly<Record<QuestionMode, number>>,
  effortCostMilli: { brief: 100, moderate: 300, extended: 600 } as Readonly<Record<Effort, number>>,
} as const;

export interface RankingFactors {
  readonly relevanceMilli: number;
  readonly severityMilli: number;
  readonly distinguishingMilli: number;
  readonly observabilityMilli: number;
  readonly costMilli: number;
}

export interface RankedCandidate extends ValidatedCandidate {
  readonly factors: RankingFactors;
  /** The ranking value in basis points. A deterministic ordering number of this policy, NOT a probability and not calibrated. */
  readonly valueBp: number;
  /** The largest severity among the question's opportunities (a tie-break and a display fact). */
  readonly severity: UncertaintySeverity;
}

const SEVERITY_RANK: Readonly<Record<UncertaintySeverity, number>> = {
  critical: 3,
  high: 2,
  moderate: 1,
  low: 0,
};

/** Relevance of one opportunity in thousandths: the rubric share of its dimensions, or the fixed floor of its kind when it has none. */
export function opportunityRelevanceMilli(opportunity: UncertaintyOpportunity): number {
  if (opportunity.dimensionIds.length > 0) return opportunity.relevanceMilli;
  switch (opportunity.kind) {
    case 'requirement_unaddressed':
      return opportunity.trail.some((entry) => entry.type === 'track')
        ? RANKING.floors.requirementTrack
        : RANKING.floors.requirementOverall;
    case 'track_rubric_not_assessed':
      return RANKING.floors.trackRubric;
    default:
      return RANKING.floors.unattributed;
  }
}

export function rankCandidate(
  candidate: ValidatedCandidate,
  opportunities: ReadonlyMap<string, UncertaintyOpportunity>,
): RankedCandidate {
  const linked = candidate.opportunityIds.flatMap((id) => {
    const found = opportunities.get(id);
    return found ? [found] : [];
  });
  if (linked.length === 0) throw new Error('internal: a validated candidate has no opportunity');

  // R: noisy-or, in integer thousandths
  const remainder = linked.reduce(
    (product, o) => (product * (1000 - opportunityRelevanceMilli(o))) / 1000,
    1000,
  );
  const relevanceMilli = Math.round(1000 - remainder);
  const severityMilli = Math.max(...linked.map((o) => RANKING.severityMilli[o.severity]));
  const ceiling = Math.max(...linked.map((o) => RANKING.distinguishingCeilingMilli[o.kind]));
  const distinguishingMilli = Math.min(ceiling, RANKING.proposalMilli[candidate.distinguishes]);
  const observabilityMilli = RANKING.observabilityMilli[candidate.mode];
  const costMilli = Math.max(
    RANKING.modeCostMilli[candidate.mode],
    RANKING.effortCostMilli[candidate.effort],
  );

  const value =
    (relevanceMilli / 1000) *
    (severityMilli / 1000) *
    (distinguishingMilli / 1000) *
    (0.5 + 0.5 * (observabilityMilli / 1000)) *
    (1 / (1 + costMilli / 1000));
  const severity = linked
    .map((o) => o.severity)
    .reduce((best, next) => (SEVERITY_RANK[next] > SEVERITY_RANK[best] ? next : best));
  return {
    ...candidate,
    factors: { relevanceMilli, severityMilli, distinguishingMilli, observabilityMilli, costMilli },
    valueBp: Math.round(value * 10_000),
    severity,
  };
}

export function rankCandidates(
  candidates: readonly ValidatedCandidate[],
  opportunities: readonly UncertaintyOpportunity[],
): RankedCandidate[] {
  const byId = new Map(opportunities.map((o) => [o.id, o] as const));
  return candidates.map((candidate) => rankCandidate(candidate, byId));
}

/** The total order of the ranking: higher value, then higher severity, then lower cost, then the candidate key. */
export function compareRanked(a: RankedCandidate, b: RankedCandidate): number {
  if (b.valueBp !== a.valueBp) return b.valueBp - a.valueBp;
  if (SEVERITY_RANK[b.severity] !== SEVERITY_RANK[a.severity])
    return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (a.factors.costMilli !== b.factors.costMilli) return a.factors.costMilli - b.factors.costMilli;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}
