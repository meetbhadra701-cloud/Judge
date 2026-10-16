import { describe, expect, it } from 'vitest';
import { analyzeUncertainty } from '@judge-copilot/uncertainty';
import { buildClosedSet } from './closed-set.js';
import { rankCandidates } from './rank.js';
import { MIN_MARGINAL_BP, overlapMilli, selectQuestions } from './select.js';
import { validateCandidates } from './validate.js';
import { candidate, handleOfKind, oneCandidatePerOpportunity, world } from './testing/world.js';
import {
  claim,
  completeCoverage,
  contradiction,
  quietInput,
  requirement,
  unknown,
} from './testing/fixture.js';
import type { UncertaintyInput } from '@judge-copilot/uncertainty';

function pipeline(
  input: UncertaintyInput,
  build?: (closed: ReturnType<typeof buildClosedSet>) => unknown[],
) {
  const report = analyzeUncertainty(input);
  const closed = buildClosedSet(report, input);
  const raw = build ? build(closed) : oneCandidatePerOpportunity(closed);
  const validated = validateCandidates({ candidates: raw }, closed);
  const ranked = rankCandidates(validated.accepted, report.opportunities);
  const result = selectQuestions(ranked, {
    opportunities: report.opportunities.length,
    rejections: validated.rejected,
  });
  return { report, closed, validated, ranked, result };
}

/** Eight independent uncertainties on four separate criteria. */
function manyUncertainties(): UncertaintyInput {
  const base = world().input;
  return {
    ...base,
    claims: [
      ...base.claims,
      claim('c-offline', { text: 'The app works offline.', supportingEvidenceIds: ['ev-orig'] }),
      claim('c-export', { text: 'Data export is supported.', supportingEvidenceIds: ['ev-pres'] }),
    ],
    unknowns: [
      ...base.unknowns,
      unknown('u-eligibility', {
        unknownType: 'eligibility',
        text: 'Team size is not stated.',
        evidenceIds: ['ev-pres'],
      }),
    ],
    contradictions: [
      contradiction('k-1', [
        { type: 'claim', id: 'c-adoption' },
        { type: 'evidence', id: 'ev-orig' },
      ]),
    ],
  };
}

describe('selection: how many questions, and why', () => {
  it('selects exactly five when there are more than five meaningful uncertainties, ranked 1..5 with falling marginal value', () => {
    const { result, report } = pipeline(manyUncertainties());
    expect(report.opportunities.length).toBeGreaterThan(5);
    expect(result.selected).toHaveLength(5);
    expect(result.selected.map((q) => q.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(result.shortfall).toBeNull();
    const marginals = result.selected.map((q) => q.marginalBp);
    expect(marginals.every((m) => m >= MIN_MARGINAL_BP)).toBe(true);
    expect(new Set(result.selected.map((q) => q.key)).size).toBe(5);
    // nothing selected twice for the same uncertainty
    const opportunityIds = result.selected.flatMap((q) => q.opportunityIds);
    expect(new Set(opportunityIds).size).toBe(opportunityIds.length);
  });

  it('selects exactly five when exactly five candidates exist', () => {
    const { result } = pipeline(manyUncertainties(), (closed) =>
      oneCandidatePerOpportunity(closed).slice(0, 5),
    );
    expect(result.selected).toHaveLength(5);
    expect(result.shortfall).toBeNull();
  });

  it('never pads: with three defensible candidates it returns three and explains the shortfall', () => {
    const { result } = pipeline(manyUncertainties(), (closed) =>
      oneCandidatePerOpportunity(closed).slice(0, 3),
    );
    expect(result.selected).toHaveLength(3);
    expect(result.shortfall?.code).toBe('fewer_defensible_candidates');
    expect(result.shortfall?.explanation).toMatch(/not padded/);
    expect(result.shortfall?.explanation).toMatch(/ask your own questions/);
  });

  it('returns no questions and says why when nothing is uncertain', () => {
    const { result, report } = pipeline(quietInput());
    expect(report.opportunities).toEqual([]);
    expect(result.selected).toEqual([]);
    expect(result.shortfall?.code).toBe('no_uncertainty');
    expect(result.shortfall?.explanation).toMatch(/without a real uncertainty/);
  });

  it('returns no questions when every candidate fails validation, and counts the refusals by code', () => {
    const { result } = pipeline(manyUncertainties(), (closed) =>
      closed.opportunities.slice(0, 4).map((entry, index) =>
        candidate({
          opportunities: [entry.handle],
          text: `Did your team fake feature number ${String(index)}?`,
        }),
      ),
    );
    expect(result.selected).toEqual([]);
    expect(result.shortfall?.code).toBe('no_valid_candidates');
    expect(result.rejections).toEqual([{ code: 'accusatory_wording', count: 4 }]);
  });

  it('with every criterion insufficient and no source captured it still asks, about the missing material, and nothing is scored', () => {
    const base = quietInput();
    const { result, report } = pipeline({
      ...base,
      dimensions: base.dimensions.map((d) => ({
        ...d,
        state: 'insufficient_evidence' as const,
        insufficiencyReason: 'no_usable_citation' as const,
        attribution: 'insufficient_by_code' as const,
        citedEvidenceIds: [],
      })),
      coverage: {
        ...completeCoverage,
        verdict: 'insufficient',
        missingSources: ['github', 'devpost'],
        implementation: null,
      },
    });
    expect(
      report.opportunities.every((o) =>
        ['dimension_not_assessed', 'source_missing'].includes(o.kind),
      ),
    ).toBe(true);
    expect(result.selected.length).toBeGreaterThan(0);
    expect(result.selected.length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(result)).not.toMatch(/"score"/);
  });

  it('keeps contradictory evidence in the set: a recorded contradiction is selected ahead of low-severity housekeeping', () => {
    const { result } = pipeline(manyUncertainties());
    const kinds = result.selected.flatMap((q) => q.opportunityIds);
    const contradictionId = analyzeUncertainty(manyUncertainties()).opportunities.find(
      (o) => o.kind === 'contradiction_recorded',
    )?.id;
    expect(kinds).toContain(contradictionId);
  });
});

describe('selection: golden', () => {
  it('pins the order, values and marginal values of the reference world (a change here is a change of policy and needs a new policy version)', () => {
    const { result, closed } = pipeline(world().input);
    const handleOf = (id: string | undefined) =>
      closed.opportunities.find((o) => o.opportunity.id === id)?.handle;
    expect(
      result.selected.map((q) => [
        q.rank,
        q.valueBp,
        q.marginalBp,
        q.noveltyMilli,
        handleOf(q.opportunityIds[0]),
      ]),
    ).toEqual([
      [1, 1800, 1800, 1000, 'O-002'],
      [2, 1350, 1350, 1000, 'O-005'],
      [3, 1050, 1050, 1000, 'O-003'],
      [4, 1700, 850, 500, 'O-001'],
      [5, 1275, 638, 500, 'O-004'],
    ]);
    expect(result.shortfall).toBeNull();
    expect(result.counts).toEqual({ opportunities: 6, candidates: 6, rejected: 0, selected: 5 });
  });
});

describe('selection: spread, weights and domination', () => {
  it('uneven weights: the question about the heaviest criterion is asked first, and reweighting the rubric reorders it', () => {
    const heavyTechnical = pipeline(world().input);
    expect(heavyTechnical.result.selected[0]?.dimensionIds).toEqual(['official.technical_depth']);

    const reweighted = world().input;
    const impactHeavy = {
      ...reweighted,
      dimensions: reweighted.dimensions.map((d) =>
        d.id === 'official.impact'
          ? { ...d, criterionWeight: 0.7 }
          : d.id === 'official.technical_depth'
            ? { ...d, criterionWeight: 0.05 }
            : d,
      ),
    };
    expect(pipeline(impactHeavy).result.selected[0]?.dimensionIds).toEqual(['official.impact']);
  });

  it('one issue dominating the pool cannot take all five slots: variants of it lose value once one is chosen', () => {
    const w = world();
    const dominant = handleOfKind(w.closed, 'claim_unverified');
    const others = w.closed.opportunities.filter((o) => o.handle !== dominant).slice(0, 4);
    const variants = [
      'Could you demonstrate the batch intake of the streaming pipeline live?',
      'Would you trace one event through the pipeline source code on screen?',
      'Can you show the dashboard that reports the pipeline throughput?',
    ];
    const distinct = [
      'Would you explain which cache policy decides when stored results expire?',
      'Could you open the folder holding the scheduler and describe its main loop?',
      'Can you show where a team member would find the dataset licence?',
      'Please describe how a new volunteer would be onboarded without developer help.',
    ];
    const raw = [
      ...variants.map((text) => candidate({ opportunities: [dominant], text })),
      ...others.map((o, index) =>
        candidate({ opportunities: [o.handle], text: distinct[index] ?? 'x', mode: 'clarify' }),
      ),
    ];
    const { result } = pipeline(w.input, () => raw);
    const dominantId = w.closed.opportunities.find((o) => o.handle === dominant)?.opportunity.id;
    expect(result.selected.length).toBeGreaterThanOrEqual(4);
    expect(result.selected.filter((q) => q.opportunityIds.includes(dominantId ?? '')).length).toBe(
      1,
    );
  });

  it('near-identical phrasings of different questions are treated as one question, not padded to five', () => {
    const w = world();
    const raw = w.closed.opportunities.slice(0, 4).map((o, index) =>
      candidate({
        opportunities: [o.handle],
        mode: 'clarify',
        text: `Would you explain how ${['zulu', 'yankee', 'xray', 'whiskey'][index] ?? 'delta'} component was verified during testing?`,
      }),
    );
    const { result } = pipeline(w.input, () => raw);
    expect(result.selected.length).toBeLessThan(4);
  });

  it('templated phrasing around different criteria is two questions; near-identical wording is one even when the records differ', () => {
    const w = world();
    const onCriterion = (id: string) =>
      w.closed.opportunities.find((o) => o.opportunity.dimensionIds.join() === id);
    const first = onCriterion('official.technical_depth');
    const second = onCriterion('official.impact');
    if (!first || !second) throw new Error('expected one opportunity on each of two criteria');
    const phrase = (subject: string) =>
      `Could you show us a concrete example from the project that illustrates ${subject}?`;
    const alike = pipeline(w.input, () => [
      candidate({
        opportunities: [first.handle],
        mode: 'show_me',
        text: phrase('the first criterion'),
      }),
      candidate({
        opportunities: [second.handle],
        mode: 'show_me',
        text: phrase('the second criterion'),
      }),
    ]);
    // no shared opportunity, record or criterion: alike wording does not make them redundant
    const [a, b] = alike.ranked;
    if (!a || !b) throw new Error('expected two ranked candidates');
    expect(a.opportunityIds).not.toEqual(b.opportunityIds);
    expect(a.dimensionIds.some((id) => b.dimensionIds.includes(id))).toBe(false);
    expect(overlapMilli(a, b)).toBeLessThan(700);
    expect(alike.result.selected).toHaveLength(2);

    const same =
      'Could you show us how the streaming pipeline handles a failed batch on the project itself?';
    const identical = pipeline(w.input, () => [
      candidate({ opportunities: [first.handle], mode: 'show_me', text: same }),
      candidate({ opportunities: [second.handle], mode: 'show_me', text: `${same} ` }),
    ]);
    // identical wording is refused as a duplicate at validation, whatever the records
    expect(identical.validated.rejected.map((r) => r.code)).toEqual(['duplicate_of_candidate']);
  });

  it('overlap is symmetric, bounded, and 1000 for a question about the same issue', () => {
    const { ranked } = pipeline(manyUncertainties());
    const [a, b] = ranked;
    if (!a || !b) throw new Error('expected two ranked candidates');
    expect(overlapMilli(a, a)).toBe(1000);
    expect(overlapMilli(a, b)).toBe(overlapMilli(b, a));
    expect(overlapMilli(a, b)).toBeGreaterThanOrEqual(0);
    expect(overlapMilli(a, b)).toBeLessThanOrEqual(1000);
  });

  it('multiple tracks and sponsor requirements: each track’s requirement can be asked, and a sponsor track rubric is not silently dropped', () => {
    const base = quietInput();
    const { result, report } = pipeline({
      ...base,
      tracks: {
        declared: [
          { key: 'sponsor-a', name: 'Sponsor A Prize' },
          { key: 'sponsor-b', name: 'Sponsor B Prize' },
        ],
        unassessedTrackRubrics: [
          { trackKey: 'sponsor-a', trackName: 'Sponsor A Prize', rubricName: 'Sponsor A criteria' },
        ],
      },
      requirements: [
        requirement('r-a', { trackKey: 'sponsor-a', text: 'Must call the Sponsor A API.' }),
        requirement('r-b', {
          trackKey: 'sponsor-b',
          text: 'Must deploy on the Sponsor B platform.',
        }),
      ],
    });
    expect(report.opportunities.map((o) => o.kind).sort()).toEqual([
      'requirement_unaddressed',
      'requirement_unaddressed',
      'track_rubric_not_assessed',
    ]);
    expect(result.selected).toHaveLength(3);
    expect(result.shortfall?.code).toBe('fewer_defensible_candidates');
  });
});

describe('selection: determinism and score independence', () => {
  it('is identical for identical input and for a reversed candidate order', () => {
    const forward = pipeline(manyUncertainties());
    const backward = pipeline(manyUncertainties(), (closed) =>
      oneCandidatePerOpportunity(closed).reverse(),
    );
    expect(forward.result.selected.map((q) => q.key).sort()).toEqual(
      backward.result.selected.map((q) => q.key).sort(),
    );
    expect(JSON.stringify(pipeline(manyUncertainties()).result)).toBe(
      JSON.stringify(forward.result),
    );
  });

  it('breaks exact ties by the candidate key, so the result never depends on arrival order', () => {
    const base = quietInput({
      requirements: [
        requirement('r-1', { text: 'Rule one.' }),
        requirement('r-2', { text: 'Rule two.' }),
      ],
    });
    const a = pipeline(base);
    const b = pipeline(base, (closed) => oneCandidatePerOpportunity(closed).reverse());
    expect(a.result.selected.map((q) => q.key)).toEqual(b.result.selected.map((q) => q.key));
  });

  it('changes no score: the engine’s input dimensions are not modified and no output field carries one', () => {
    const input = manyUncertainties();
    const before = JSON.stringify(input);
    const { result } = pipeline(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.keys(result.selected[0] ?? {})).not.toContain('score');
  });
});
