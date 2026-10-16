import { describe, expect, it } from 'vitest';
import type { UncertaintyOpportunity } from '@judge-copilot/uncertainty';
import { opportunityRelevanceMilli, rankCandidates, RANKING } from './rank.js';
import { validateCandidates } from './validate.js';
import { candidate, handleOfKind, world } from './testing/world.js';

const { report, closed } = world();

const rank = (...cands: ReturnType<typeof candidate>[]) => {
  const validated = validateCandidates({ candidates: cands }, closed);
  expect(validated.rejected).toEqual([]);
  return rankCandidates(validated.accepted, report.opportunities);
};

describe('ranking: the formula is exactly what the documentation says', () => {
  it('golden value: R .40 × S .75 × D .90 × (0.5+0.5·1.0) ÷ (1+0.5) = 1800 bp', () => {
    const [ranked] = rank(candidate({ opportunities: [handleOfKind(closed, 'claim_unverified')] }));
    // The first claim_unverified opportunity is the streaming pipeline claim, which bears on the 40 % technical-depth criterion.
    expect(ranked?.factors).toEqual({
      relevanceMilli: 400,
      severityMilli: 750,
      distinguishingMilli: 900, // the proposal is "strong" (1000) but the kind's ceiling is 900
      observabilityMilli: 1000,
      costMilli: 500,
    });
    expect(ranked?.valueBp).toBe(1800);
  });

  it('a proposal can lower distinguishing power but never raise it above the ceiling of the uncertainty', () => {
    const opp = handleOfKind(closed, 'claim_unverified');
    const strong = rank(candidate({ opportunities: [opp], distinguishes: 'strong' }))[0];
    const weak = rank(candidate({ opportunities: [opp], distinguishes: 'weak' }))[0];
    expect(weak?.factors.distinguishingMilli).toBe(400);
    expect(strong?.factors.distinguishingMilli).toBeLessThanOrEqual(900);
    expect(strong?.valueBp ?? 0).toBeGreaterThan(weak?.valueBp ?? 0);
  });

  it('an observable request outranks a verbal assurance of equal weight, and a cheaper one outranks a costlier one', () => {
    const opp = handleOfKind(closed, 'claim_unverified');
    const show = rank(candidate({ opportunities: [opp], mode: 'show_me', effort: 'brief' }))[0];
    const ask = rank(
      candidate({
        opportunities: [opp],
        mode: 'ask',
        effort: 'brief',
        text: 'What measurement produced the throughput figure in the materials?',
      }),
    )[0];
    expect(show?.factors.observabilityMilli).toBeGreaterThan(ask?.factors.observabilityMilli ?? 0);
    expect(show?.factors.costMilli).toBe(300);
    expect(ask?.factors.costMilli).toBe(100);
  });

  it('the model’s proposed effort can only add cost, never remove the mode’s own floor', () => {
    const opp = handleOfKind(closed, 'claim_unverified');
    const cheapDemo = rank(
      candidate({ opportunities: [opp], mode: 'demonstrate', effort: 'brief' }),
    )[0];
    expect(cheapDemo?.factors.costMilli).toBe(RANKING.modeCostMilli.demonstrate);
    const longAsk = rank(
      candidate({
        opportunities: [opp],
        mode: 'ask',
        effort: 'extended',
        text: 'What measurement produced the throughput figure?',
      }),
    )[0];
    expect(longAsk?.factors.costMilli).toBe(RANKING.effortCostMilli.extended);
  });

  it('relevance is a noisy-or over the opportunities a question addresses (two issues are worth more than one, never more than 1)', () => {
    const claimOpp = handleOfKind(closed, 'claim_unverified');
    const coverageOpp = handleOfKind(closed, 'coverage_partial');
    const one = rank(candidate({ opportunities: [claimOpp] }))[0];
    const two = rank(candidate({ opportunities: [claimOpp, coverageOpp] }))[0];
    expect(two?.factors.relevanceMilli ?? 0).toBeGreaterThan(one?.factors.relevanceMilli ?? 0);
    expect(two?.factors.relevanceMilli ?? 2000).toBeLessThanOrEqual(1000);
  });

  it('uses fixed floors, not a score, for an opportunity with no scored dimension', () => {
    const synthetic = (
      kind: UncertaintyOpportunity['kind'],
      trailType: 'track' | 'requirement',
    ): UncertaintyOpportunity => ({
      id: 'opp-0000000000000000',
      ordinal: 1,
      kind,
      severity: 'high',
      dimensionIds: [],
      relevanceMilli: 0,
      observation: 'x',
      clarifiedBy: ['explanation'],
      trail: [{ type: trailType, id: 'x', role: 'subject' }],
    });
    expect(opportunityRelevanceMilli(synthetic('requirement_unaddressed', 'track'))).toBe(500);
    expect(opportunityRelevanceMilli(synthetic('requirement_unaddressed', 'requirement'))).toBe(
      250,
    );
    expect(opportunityRelevanceMilli(synthetic('track_rubric_not_assessed', 'track'))).toBe(500);
    expect(opportunityRelevanceMilli(synthetic('unknown_recorded', 'requirement'))).toBe(200);
  });
});

describe('ranking: determinism and independence from scores', () => {
  it('the same candidates in any order give the same values', () => {
    const a = candidate({ opportunities: [handleOfKind(closed, 'claim_unverified')] });
    const b = candidate({
      opportunities: [handleOfKind(closed, 'coverage_partial')],
      text: 'Could you open the pipeline module and trace one event through it?',
    });
    const forward = rank(a, b).map((r) => [r.key, r.valueBp] as const);
    const backward = rank(b, a).map((r) => [r.key, r.valueBp] as const);
    expect(new Map(forward)).toEqual(new Map(backward));
  });

  it('a heavier rubric criterion raises the value of a question about it, and reweighting changes nothing but that', () => {
    const light = world({
      dimensions: world().input.dimensions.map((d) =>
        d.id === 'official.technical_depth' ? { ...d, criterionWeight: 0.1 } : d,
      ),
    });
    const lightOpp = handleOfKind(light.closed, 'claim_unverified');
    const lightRanked = rankCandidates(
      validateCandidates({ candidates: [candidate({ opportunities: [lightOpp] })] }, light.closed)
        .accepted,
      light.report.opportunities,
    )[0];
    const heavy = rank(candidate({ opportunities: [handleOfKind(closed, 'claim_unverified')] }))[0];
    expect(heavy?.valueBp ?? 0).toBeGreaterThan(lightRanked?.valueBp ?? 0);
  });
});
