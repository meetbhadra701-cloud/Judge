import {
  QUESTION_SET_SIZE,
  type CandidateRejection,
  type QuestionShortfall,
} from '@judge-copilot/schemas';
import { tokenJaccard } from './validate.js';
import { compareRanked, type RankedCandidate } from './rank.js';

/*
 * Five-question selection: deterministic, greedy by MARGINAL value, diverse by construction.
 *
 *   marginal(q | S) = value(q) × novelty(q | S)             novelty(q | S) = Π over s ∈ S of (1 − overlap(q, s))
 *   overlap(q, s)   = max( J(opportunities), w·J(references), 0.5·J(dimensions), J(text) if the wording is near-identical, or similar AND the two address the same uncertainty or criterion )     J = Jaccard similarity;
 *                     w = 0.8 when they address the same uncertainty or criterion, and 0.4 when they do not (the same record cited for two different criteria is partial overlap, not a repeat)
 *
 * Each round selects the candidate with the highest marginal value (ties: the ranking's total order). The loop stops when five are chosen, or when the best
 * remaining marginal value is below MIN_MARGINAL_BP: a question that would add (almost) nothing is not selected, so the list is never padded. An issue that
 * dominates the candidate pool (many questions about one feature) loses value as soon as one of them is chosen, so the five are spread across distinct
 * uncertainties and distinct dimensions.
 */

/** A question whose marginal value is below this (3 %) adds too little to be worth interview time. */
export const MIN_MARGINAL_BP = 300;

export interface SelectedQuestion extends RankedCandidate {
  /** 1-based, in the order to ask: the first selected is the most valuable, each later one the most valuable ADDITION to the earlier ones. */
  readonly rank: number;
  readonly marginalBp: number;
  readonly noveltyMilli: number;
}

export interface SelectionResult {
  readonly selected: readonly SelectedQuestion[];
  readonly shortfall: { readonly code: QuestionShortfall; readonly explanation: string } | null;
  readonly counts: {
    readonly opportunities: number;
    readonly candidates: number;
    readonly rejected: number;
    readonly selected: number;
  };
  readonly rejections: readonly { readonly code: CandidateRejection; readonly count: number }[];
}

const jaccard = <T>(a: readonly T[], b: readonly T[]): number => {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) return 0;
  let both = 0;
  for (const value of left) if (right.has(value)) both += 1;
  return both / (left.size + right.size - both);
};

/**
 * Wording that is this close is the same question however it was reached.
 * Below it, similar wording is evidence of redundancy only when the two questions are also about the same uncertainty or criterion: two questions about
 * DIFFERENT criteria that happen to be phrased alike ("... an example that illustrates X") ask for different things and are both worth asking.
 */
export const NEAR_IDENTICAL_TEXT = 0.95;
export const SIMILAR_TEXT = 0.7;
const SHARED_RECORD_WEIGHT_SAME_TOPIC = 0.8;
const SHARED_RECORD_WEIGHT_OTHER_TOPIC = 0.4;

/** How much of `a`'s value is already delivered by `b`, in thousandths. Symmetric. */
export function overlapMilli(a: RankedCandidate, b: RankedCandidate): number {
  const references = (c: RankedCandidate): string[] => c.references.map((r) => `${r.type}:${r.id}`);
  const opportunities = jaccard(a.opportunityIds, b.opportunityIds);
  const records = jaccard(references(a), references(b));
  const dimensions = jaccard(a.dimensionIds, b.dimensionIds);
  const text = tokenJaccard(a.text, b.text);
  // the same uncertainty or the same rubric criterion: the two questions are about the same thing
  const sameTopic = opportunities > 0 || dimensions > 0;
  const overlap = Math.max(
    opportunities,
    (sameTopic ? SHARED_RECORD_WEIGHT_SAME_TOPIC : SHARED_RECORD_WEIGHT_OTHER_TOPIC) * records,
    0.5 * dimensions,
    text >= NEAR_IDENTICAL_TEXT || (text >= SIMILAR_TEXT && sameTopic) ? text : 0,
  );
  return Math.min(1000, Math.round(overlap * 1000));
}

export function selectQuestions(
  ranked: readonly RankedCandidate[],
  context: {
    readonly opportunities: number;
    readonly rejections: readonly { readonly code: CandidateRejection }[];
    readonly size?: number;
  },
): SelectionResult {
  const size = context.size ?? QUESTION_SET_SIZE;
  const pool = [...ranked].sort(compareRanked);
  const selected: SelectedQuestion[] = [];
  const remaining = [...pool];
  while (selected.length < size && remaining.length > 0) {
    let best: {
      candidate: RankedCandidate;
      marginalBp: number;
      noveltyMilli: number;
      index: number;
    } | null = null;
    remaining.forEach((candidate, index) => {
      const noveltyMilli = selected.reduce(
        (product, chosen) =>
          Math.floor((product * (1000 - overlapMilli(candidate, chosen))) / 1000),
        1000,
      );
      const marginalBp = Math.round((candidate.valueBp * noveltyMilli) / 1000);
      // `remaining` is in the ranking's total order, so the first of equal marginal values wins and the result is deterministic
      if (best === null || marginalBp > best.marginalBp)
        best = { candidate, marginalBp, noveltyMilli, index };
    });
    const chosen = best as {
      candidate: RankedCandidate;
      marginalBp: number;
      noveltyMilli: number;
      index: number;
    } | null;
    if (chosen === null || chosen.marginalBp < MIN_MARGINAL_BP) break;
    remaining.splice(chosen.index, 1);
    selected.push({
      ...chosen.candidate,
      rank: selected.length + 1,
      marginalBp: chosen.marginalBp,
      noveltyMilli: chosen.noveltyMilli,
    });
  }

  const counts = new Map<CandidateRejection, number>();
  for (const { code } of context.rejections) counts.set(code, (counts.get(code) ?? 0) + 1);
  const rejections = [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  let shortfall: SelectionResult['shortfall'] = null;
  if (selected.length < size) {
    if (context.opportunities === 0) {
      shortfall = {
        code: 'no_uncertainty',
        explanation:
          'The analysis found nothing that could materially change what you understand about this project: every criterion has evidence behind it and nothing the assessment examined is contradicted or unseen. No question was generated, because a question without a real uncertainty behind it would only fill space. You can still ask your own.',
      };
    } else if (pool.length === 0) {
      shortfall = {
        code: 'no_valid_candidates',
        explanation:
          'Uncertainties were found, but no candidate question passed validation (each failed the checks on references, wording or shape). No question is shown rather than one that was not checked. Use the uncertainties listed below to prepare your own questions.',
      };
    } else if (pool.length < size) {
      shortfall = {
        code: 'fewer_defensible_candidates',
        explanation: `Only ${String(selected.length)} defensible question${selected.length === 1 ? '' : 's'} could be generated: there ${pool.length === 1 ? 'was' : 'were'} ${String(pool.length)} valid candidate${pool.length === 1 ? '' : 's'}, and the list is not padded with filler. The uncertainties listed below are what is still open; ask your own questions about them.`,
      };
    } else {
      shortfall = {
        code: 'redundant_candidates',
        explanation: `${String(pool.length)} valid candidates were generated, but after the first ${String(selected.length)} each remaining one largely repeated a question already selected, so they were not added. The list is not padded; the uncertainties below are what is still open.`,
      };
    }
  }
  return {
    selected,
    shortfall,
    counts: {
      opportunities: context.opportunities,
      candidates: pool.length,
      rejected: context.rejections.length,
      selected: selected.length,
    },
    rejections,
  };
}
