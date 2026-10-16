import { describe, expect, it } from 'vitest';
import { MIN_MARGINAL_BP, selectQuestions } from './select.js';
import type { RankedCandidate } from './rank.js';

/*
 * M6-R1 (R9A P2-4): the shortfall names the cause that actually stopped the selection, taken from each left-out candidate's own numbers, never inferred from
 * the size of the pool. Every pool below has SIX valid candidates; only the cause differs.
 */

let counter = 0;
function cand(
  over: Partial<RankedCandidate> & { opp: string; valueBp: number; topic?: string },
): RankedCandidate {
  counter += 1;
  const { opp, valueBp, topic, ...rest } = over;
  return {
    key: `cand-${counter.toString(16).padStart(16, '0')}`,
    mode: 'ask',
    text: `Distinct wording number ${String(counter)} about ${topic ?? `topic${String(counter)}x${String(counter * 7)}`} and its own details?`,
    reason: 'reason',
    expectedInformation: ['explanation'],
    opportunityIds: [opp],
    dimensionIds: [],
    references: [],
    distinguishes: 'moderate',
    effort: 'brief',
    outputIndex: counter,
    factors: {
      relevanceMilli: 500,
      severityMilli: 750,
      distinguishingMilli: 700,
      observabilityMilli: 300,
      costMilli: 100,
    },
    valueBp,
    severity: 'high',
    ...rest,
  };
}
const ctx = { opportunities: 6, rejections: [] };
const opp = (n: number) => `opp-${String(n).repeat(16)}`;

describe('shortfall causes over equal pools of six valid candidates', () => {
  it('all below the minimum value: nothing is selected and the cause is the low value, not repetition', () => {
    const pool = [1, 2, 3, 4, 5, 6].map((n) =>
      cand({ opp: opp(n), valueBp: MIN_MARGINAL_BP - 100 }),
    );
    const result = selectQuestions(pool, ctx);
    expect(result.selected).toHaveLength(0);
    expect(result.counts.candidates).toBe(6);
    expect(result.excluded).toEqual({ redundant: 0, belowMinimum: 6 });
    expect(result.shortfall?.code).toBe('below_minimum_value');
    expect(result.shortfall?.explanation).toMatch(
      /6 valid candidates were generated and 0 were selected/,
    );
    expect(result.shortfall?.explanation).toMatch(/below the minimum worth asking/);
    expect(result.shortfall?.explanation).not.toMatch(/repeated/);
  });

  it('all repeats of one question: one is selected and the other five are reported as repeats', () => {
    const shared = opp(9);
    const pool = [1, 2, 3, 4, 5, 6].map(() => cand({ opp: shared, valueBp: 2000 - counter }));
    const result = selectQuestions(pool, ctx);
    expect(result.selected).toHaveLength(1);
    expect(result.excluded).toEqual({ redundant: 5, belowMinimum: 0 });
    expect(result.shortfall?.code).toBe('redundant_candidates');
    expect(result.shortfall?.explanation).toMatch(/5 were left out because each largely repeated/);
    expect(result.shortfall?.explanation).not.toMatch(/below the minimum/);
  });

  it('two good questions, two repeats of them and two of too little value: the causes are reported together', () => {
    const good = [cand({ opp: opp(1), valueBp: 2000 }), cand({ opp: opp(2), valueBp: 1900 })];
    const repeats = [cand({ opp: opp(1), valueBp: 1800 }), cand({ opp: opp(2), valueBp: 1700 })];
    const low = [cand({ opp: opp(3), valueBp: 120 }), cand({ opp: opp(4), valueBp: 90 })];
    const result = selectQuestions([...low, ...repeats, ...good], ctx);
    expect(result.selected).toHaveLength(2);
    expect(result.excluded).toEqual({ redundant: 2, belowMinimum: 2 });
    expect(result.shortfall?.code).toBe('mixed_causes');
    expect(result.shortfall?.explanation).toMatch(/2 were left out because each largely repeated/);
    expect(result.shortfall?.explanation).toMatch(
      /2 were left out because the value of asking each/,
    );
  });

  it('five distinct good questions among six: five selected, no shortfall, the sixth is simply not needed', () => {
    const pool = [1, 2, 3, 4, 5, 6].map((n) => cand({ opp: opp(n), valueBp: 2000 - n * 10 }));
    const result = selectQuestions(pool, ctx);
    expect(result.selected).toHaveLength(5);
    expect(result.shortfall).toBeNull();
    expect(result.excluded).toEqual({ redundant: 0, belowMinimum: 0 });
  });

  it('only three valid candidates, all selected: fewer than five valid candidates (a different cause again)', () => {
    const pool = [1, 2, 3].map((n) => cand({ opp: opp(n), valueBp: 2000 }));
    const result = selectQuestions(pool, ctx);
    expect(result.selected).toHaveLength(3);
    expect(result.shortfall?.code).toBe('fewer_defensible_candidates');
    expect(result.shortfall?.explanation).toMatch(/Only 3 defensible questions/);
  });

  it('a candidate whose own value is just above the minimum but is pushed below it by overlap counts as a repeat, not as low value', () => {
    const first = cand({ opp: opp(1), valueBp: 2000 });
    const nearlyTheSame = cand({ opp: opp(1), valueBp: MIN_MARGINAL_BP + 50 });
    const result = selectQuestions([first, nearlyTheSame], ctx);
    expect(result.excluded).toEqual({ redundant: 1, belowMinimum: 0 });
    expect(result.shortfall?.code).toBe('redundant_candidates');
  });

  it('the distinction does not depend on the number of candidates: identical pool sizes give different codes', () => {
    const lowPool = [1, 2, 3, 4, 5, 6].map((n) => cand({ opp: opp(n), valueBp: 100 }));
    const repeatPool = [1, 2, 3, 4, 5, 6].map(() => cand({ opp: opp(8), valueBp: 1500 }));
    expect(selectQuestions(lowPool, ctx).shortfall?.code).not.toBe(
      selectQuestions(repeatPool, ctx).shortfall?.code,
    );
  });

  it('is deterministic and never pads: the same pool in any order gives the same selection and the same words', () => {
    const pool = [
      cand({ opp: opp(1), valueBp: 2000 }),
      cand({ opp: opp(1), valueBp: 1800 }),
      cand({ opp: opp(3), valueBp: 100 }),
    ];
    const a = selectQuestions(pool, ctx);
    const b = selectQuestions([...pool].reverse(), ctx);
    expect(b.shortfall).toEqual(a.shortfall);
    expect(b.selected.map((q) => q.key)).toEqual(a.selected.map((q) => q.key));
    expect(a.selected.length).toBeLessThan(5);
  });
});
