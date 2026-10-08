import type { ScoreReport } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import { aggregate } from './aggregate.js';
import { scoreProject } from './engine.js';
import type { DimensionResult } from './dimension.js';
import type { CriterionSpec, DimensionSpec, RubricSpec } from './rubric/spec.js';
import {
  baseWorld,
  cite,
  criterionScored,
  devpostEvidence,
  fallbackPayload,
  lockedSnapshot,
  makeContext,
  uid,
} from './testing/builders.js';

/*
 * Aggregation in isolation, on synthetic rubrics and synthetic dimension results, so the arithmetic
 * is checked against hand-derived numbers and thresholds are probed exactly at their boundaries.
 */

function spec(id: string, weight: number, needs: boolean): DimensionSpec {
  return { id, key: id, name: id, weight, needGroups: needs ? [['source_code']] : null };
}

function rubricOf(
  criteria: {
    key: string;
    weight: number | null;
    dims: [string, number][];
    applicable?: boolean;
  }[],
  options: { weightBasis?: RubricSpec['weightBasis']; needs?: boolean } = {},
): RubricSpec {
  const needs = options.needs ?? true;
  return {
    source: 'universal_fallback',
    rubricVersion: 'fallback-rubric/v1',
    contextVersionId: null,
    contextContentHash: null,
    name: 'synthetic',
    scope: 'overall',
    trackKey: null,
    scale: { min: 0, max: 10 },
    weightBasis: options.weightBasis ?? 'fallback',
    needsBasis: needs ? 'declared' : 'unspecified',
    criteria: criteria.map((c): CriterionSpec => ({
      key: c.key,
      name: c.key,
      weight: c.weight,
      applicable: c.applicable ?? true,
      dimensions: c.dims.map(([id, weight]) => spec(`${c.key}.${id}`, weight, needs)),
    })),
  };
}

interface Stub {
  score?: number;
  confidence?: number;
  coverage?: number;
  presence?: 0 | 1;
}

function results(rubric: RubricSpec, values: Record<string, Stub | undefined>) {
  const map = new Map<string, DimensionResult>();
  for (const criterion of rubric.criteria) {
    for (const dimension of criterion.dimensions) {
      const stub = values[dimension.id];
      const needs = dimension.needGroups !== null;
      map.set(dimension.id, {
        spec: dimension,
        criterionKey: criterion.key,
        state: stub?.score === undefined ? 'insufficient_evidence' : 'assessed',
        reason: stub?.score === undefined ? 'assessor_reported_insufficient' : null,
        scoreOnScale: stub?.score ?? null,
        score10: stub?.score ?? null,
        strength: 0,
        strongestEvidenceIds: [],
        satisfiedGroups: needs ? 0 : null,
        totalGroups: needs ? 1 : null,
        coverage: needs ? (stub?.coverage ?? 0) : null,
        citationPresence: needs ? null : (stub?.presence ?? 0),
        confidenceBasis: needs ? 'declared_needs_coverage' : 'citation_presence',
        confidence: stub?.confidence ?? 0,
        contradictionIds: [],
        mappedClaimIds: new Set(),
        mappedUnknownIds: [],
        citedEvidenceIds: [],
        provenanceGroupCount: 0,
        diagnostics: [],
      });
    }
  }
  return map;
}

const only = (report: ReturnType<typeof aggregate>, key: string) => {
  const found = report.criteria.find((entry) => entry.key === key);
  if (!found) throw new Error('missing');
  return found;
};

describe('criterion aggregation (E10): excluding a unit moves the aggregate in EITHER direction', () => {
  // Weights 0.5 / 0.3 / 0.2, scores 9 / 7 / 3.
  const rubric = rubricOf([
    {
      key: 'c',
      weight: 1,
      dims: [
        ['a', 0.5],
        ['b', 0.3],
        ['c', 0.2],
      ],
    },
  ]);
  const full = { 'c.a': { score: 9 }, 'c.b': { score: 7 }, 'c.c': { score: 3 } };
  const score = (values: Record<string, Stub | undefined>) => {
    const c = only(aggregate(rubric, results(rubric, values), false), 'c');
    return 'score10' in c ? c.score10 : null;
  };

  it('uses the published weights as they are when everything is assessed -> 7.2', () => {
    expect(score(full)).toBe(7.2);
  });

  it('dropping the 9 lowers it (5.4), dropping the 3 raises it (8.25), dropping the 7 raises it (7.2857)', () => {
    expect(score({ ...full, 'c.a': undefined })).toBe(5.4);
    expect(score({ ...full, 'c.c': undefined })).toBe(8.25);
    expect(score({ ...full, 'c.b': undefined })).toBe(7.2857);
  });

  it('is never the zero-filled value (dropping the 3 would have been 6.6)', () => {
    expect(score({ ...full, 'c.c': undefined })).not.toBe(6.6);
    expect(0.5 * 9 + 0.3 * 7 + 0.2 * 0).toBeCloseTo(6.6, 12);
  });

  it('equals the renormalized mean of the remaining assessed dimensions, for every subset', () => {
    const scores = { 'c.a': 9, 'c.b': 7, 'c.c': 3 };
    const weights = { 'c.a': 0.5, 'c.b': 0.3, 'c.c': 0.2 };
    for (let mask = 1; mask < 8; mask += 1) {
      const kept = (['c.a', 'c.b', 'c.c'] as const).filter((_, i) => mask & (1 << i));
      const values: Record<string, Stub> = {};
      for (const id of kept) values[id] = { score: scores[id] };
      const c = only(aggregate(rubric, results(rubric, values), false), 'c');
      const weightKept = kept.reduce((s, id) => s + weights[id], 0);
      const expected = kept.reduce((s, id) => s + weights[id] * scores[id], 0) / weightKept;
      if (weightKept + 1e-9 >= 0.5) {
        expect('score10' in c && c.score10).toBe(Math.round(expected * 1e4) / 1e4);
      } else {
        expect(c.state).toBe('insufficient_evidence');
        expect('score10' in c).toBe(false);
      }
    }
  });
});

describe('criterion threshold: at least half of the weight must be assessed', () => {
  const rubric = rubricOf([
    {
      key: 'c',
      weight: 1,
      dims: [
        ['a', 0.5],
        ['b', 0.25],
        ['c', 0.25],
      ],
    },
  ]);
  const state = (values: Record<string, Stub | undefined>) =>
    only(aggregate(rubric, results(rubric, values), false), 'c').state;

  it('exactly 0.5 is partial; just under is insufficient', () => {
    expect(state({ 'c.a': { score: 5 } })).toBe('partial');
    expect(state({ 'c.b': { score: 5 }, 'c.c': { score: 5 } })).toBe('partial');
    const under = rubricOf([
      {
        key: 'c',
        weight: 1,
        dims: [
          ['a', 0.4999],
          ['b', 0.5001],
        ],
      },
    ]);
    expect(only(aggregate(under, results(under, { 'c.a': { score: 5 } }), false), 'c').state).toBe(
      'insufficient_evidence',
    );
  });

  it('a quarter is insufficient and nothing assessed is insufficient', () => {
    expect(state({ 'c.b': { score: 5 } })).toBe('insufficient_evidence');
    expect(state({})).toBe('insufficient_evidence');
  });

  it('everything assessed is `assessed`, not partial', () => {
    expect(state({ 'c.a': { score: 1 }, 'c.b': { score: 2 }, 'c.c': { score: 3 } })).toBe(
      'assessed',
    );
  });
});

describe('confidence and coverage are weighted over ALL children; insufficient ones count as their own value', () => {
  it('E11: dimension confidences 0.60 / 0.55 / 0 / 0.50 / 0.45 at weights 25/20/20/20/15 -> 0.4275', () => {
    const rubric = rubricOf([
      {
        key: 'c',
        weight: 1,
        dims: [
          ['a', 0.25],
          ['b', 0.2],
          ['c', 0.2],
          ['d', 0.2],
          ['e', 0.15],
        ],
      },
    ]);
    const r = aggregate(
      rubric,
      results(rubric, {
        'c.a': { score: 7, confidence: 0.6, coverage: 1 },
        'c.b': { score: 8, confidence: 0.55, coverage: 1 },
        'c.c': undefined,
        'c.d': { score: 6, confidence: 0.5, coverage: 1 },
        'c.e': { score: 7, confidence: 0.45, coverage: 0.5 },
      }),
      false,
    );
    const c = only(r, 'c');
    expect(c.state).toBe('partial');
    if (c.state === 'insufficient_evidence' || c.state === 'not_applicable')
      throw new Error('unexpected');
    expect(c.score10).toBe(7);
    expect(c.confidence).toBe(0.4275);
    expect(c.coverage).toBe(0.725); // 0.25 + 0.2 + 0 + 0.2 + 0.075
    expect(c.assessedWeightShare).toBe(0.8);
  });

  it('missing evidence lowers confidence but never the score', () => {
    const rubric = rubricOf([
      {
        key: 'c',
        weight: 1,
        dims: [
          ['a', 0.5],
          ['b', 0.5],
        ],
      },
    ]);
    const whole = only(
      aggregate(
        rubric,
        results(rubric, {
          'c.a': { score: 6, confidence: 0.8, coverage: 1 },
          'c.b': { score: 6, confidence: 0.8, coverage: 1 },
        }),
        false,
      ),
      'c',
    );
    const gap = only(
      aggregate(
        rubric,
        results(rubric, { 'c.a': { score: 6, confidence: 0.8, coverage: 1 } }),
        false,
      ),
      'c',
    );
    expect('score10' in whole && whole.score10).toBe('score10' in gap && gap.score10);
    expect(whole.state === 'assessed' && whole.confidence).toBe(0.8);
    expect(gap.state === 'partial' && gap.confidence).toBe(0.4);
  });

  it('where needs are unspecified the criterion has no coverage, only a presence share', () => {
    const rubric = rubricOf(
      [
        {
          key: 'c',
          weight: 1,
          dims: [
            ['a', 0.6],
            ['b', 0.4],
          ],
        },
      ],
      { needs: false },
    );
    const c = only(
      aggregate(
        rubric,
        results(rubric, {
          'c.a': { score: 5, confidence: 0.3, presence: 1 },
          'c.b': { presence: 0 },
        }),
        false,
      ),
      'c',
    );
    if (c.state === 'not_applicable') throw new Error('unexpected');
    expect(c.coverage).toBeNull();
    expect(c.citationPresenceShare).toBe(0.6);
  });
});

describe('overall aggregation', () => {
  const weights = { a: 0.5, b: 0.3, c: 0.2 };
  const rubric = rubricOf(
    (Object.keys(weights) as (keyof typeof weights)[]).map((key) => ({
      key,
      weight: weights[key],
      dims: [['d', 1]] as [string, number][],
    })),
  );
  const dimension = (key: string, value?: Stub) => [`${key}.d`, value] as const;
  const overall = (scores: Partial<Record<keyof typeof weights, number>>) =>
    aggregate(
      rubric,
      results(
        rubric,
        Object.fromEntries(
          (['a', 'b', 'c'] as const).map((k) =>
            dimension(k, scores[k] === undefined ? undefined : { score: scores[k] }),
          ),
        ),
      ),
      false,
    ).overall;

  it('uses published weights as they are when every criterion is scored', () => {
    expect(overall({ a: 9, b: 7, c: 3 })).toMatchObject({
      state: 'scored',
      score10: 7.2,
      assessedWeightShare: 1,
    });
  });

  it('renormalizes over scored criteria, in either direction, when at least 0.6 of the weight is scored', () => {
    expect(overall({ a: 9, b: 7 })).toMatchObject({
      state: 'scored_partial',
      score10: 8.25,
      missingCriterionKeys: ['c'],
    });
    expect(overall({ a: 9, c: 3 })).toMatchObject({
      state: 'scored_partial',
      score10: 7.2857,
      assessedWeightShare: 0.7,
    });
    expect(overall({ b: 7, c: 3 })).toMatchObject({
      state: 'insufficient_evidence',
      assessedWeightShare: 0.5,
    });
  });

  it('is insufficient_evidence below 0.6 and then carries no score', () => {
    const r = overall({ a: 9 });
    expect(r).toMatchObject({
      state: 'insufficient_evidence',
      reason: 'assessed_weight_below_threshold',
      assessedWeightShare: 0.5,
    });
    expect('score10' in r).toBe(false);
    expect(overall({})).toMatchObject({ state: 'insufficient_evidence', assessedWeightShare: 0 });
  });

  it('a lone criterion is all-or-nothing', () => {
    const single = rubricOf([{ key: 'x', weight: 1, dims: [['d', 1]] }]);
    expect(
      aggregate(single, results(single, { 'x.d': { score: 4 } }), false).overall,
    ).toMatchObject({ state: 'scored', score10: 4 });
    expect(aggregate(single, results(single, {}), false).overall.state).toBe(
      'insufficient_evidence',
    );
  });

  it('a not_applicable criterion leaves numerator and denominator and costs no confidence', () => {
    const r = rubricOf([
      { key: 'a', weight: 0.5, dims: [['d', 1]] },
      { key: 'b', weight: 0.4, dims: [['d', 1]] },
      { key: 't', weight: 0.1, dims: [['d', 1]], applicable: false },
    ]);
    const out = aggregate(
      r,
      results(r, {
        'a.d': { score: 8, confidence: 1, coverage: 1 },
        'b.d': { score: 8, confidence: 1, coverage: 1 },
      }),
      false,
    );
    expect(out.overall).toMatchObject({
      state: 'scored',
      score10: 8,
      assessedWeightShare: 1,
      confidence: 1,
      coverage: 1,
    });
    expect(only(out, 't').state).toBe('not_applicable');
  });
});

describe('thresholds and floating-point representation', () => {
  it('0.6 of the weight is scored even though IEEE arithmetic computes 0.5999999999999999 (the epsilon)', () => {
    const g = baseWorld();
    const dev = devpostEvidence(g, uid(1, 'e7000001'));
    const ctx = makeContext(g.build(), lockedSnapshot({ trackKeys: ['ai_track'] }), {
      declaredTrackKeys: ['ai_track'],
    });
    const c = cite(dev);
    // completion 0.20 + impact 0.15 + innovation 0.15 + track 0.10 = exactly 0.60 of the weight.
    const result = scoreProject(
      ctx,
      fallbackPayload(
        [
          ...criterionScored('completion_functionality', 6, c),
          ...criterionScored('impact_problem_fit', 6, c),
          ...criterionScored('innovation_creativity', 6, c),
          ...criterionScored('track_prize_alignment', 6, c),
        ],
        { withTrack: true },
      ),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const report: ScoreReport = result.report;
    // The engine folds in ascending key order over a total of 1.0000000000000002.
    expect(0.6 / 1.0000000000000002).toBeLessThan(0.6);
    expect(report.overall).toMatchObject({
      state: 'scored_partial',
      score10: 6,
      assessedWeightShare: 0.6,
    });
  });

  it('just under 0.6 is insufficient (no score)', () => {
    const g = baseWorld();
    const dev = devpostEvidence(g, uid(1, 'e7000002'));
    const ctx = makeContext(g.build(), lockedSnapshot({ trackKeys: ['ai_track'] }), {
      declaredTrackKeys: ['ai_track'],
    });
    const c = cite(dev);
    const result = scoreProject(
      ctx,
      fallbackPayload(
        [
          ...criterionScored('completion_functionality', 6, c),
          ...criterionScored('impact_problem_fit', 6, c),
          ...criterionScored('innovation_creativity', 6, c),
          ...criterionScored('design_user_experience', 6, c).slice(0, 1),
        ],
        { withTrack: true },
      ),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.report.overall).toMatchObject({
      state: 'insufficient_evidence',
      assessedWeightShare: 0.5,
    });
  });
});
