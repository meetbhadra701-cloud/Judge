import type { ScoreReport } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import { attributeDisposition, UNIT_DISPOSITION_VALUES } from './judgment.js';
import {
  canonicalReportedScore,
  JUDGMENT_MISMATCH_VALUES,
  verifyJudgmentsAgainstReport,
  type StoredJudgmentFacts,
} from './verify-report.js';

/*
 * P6A-R1: the judgment rows must agree with the verified report on everything the report also states (dimensions, state, number,
 * cited evidence ids, scored-iff-assessed). Only the fields the verifier reads are modeled; the report itself is verified elsewhere.
 */

const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';

const report = {
  dimensions: [
    { id: 'a.one', state: 'assessed', scoreOnScale: 7, citedEvidenceIds: [E1, E2] },
    { id: 'a.two', state: 'insufficient_evidence', citedEvidenceIds: [E1] },
    { id: 'a.three', state: 'insufficient_evidence', citedEvidenceIds: [] },
  ],
} as unknown as ScoreReport;

const rows = (): StoredJudgmentFacts[] => [
  {
    dimensionId: 'a.one',
    outcomeKind: 'scored',
    score: 7,
    disposition: 'scored',
    citationEvidenceIds: [E2, E1],
  },
  {
    dimensionId: 'a.two',
    outcomeKind: 'insufficient_evidence',
    score: null,
    disposition: 'assessor_reported_insufficient',
    citationEvidenceIds: [E1],
  },
  {
    dimensionId: 'a.three',
    outcomeKind: 'insufficient_evidence',
    score: null,
    disposition: 'no_candidate_evidence',
    citationEvidenceIds: [],
  },
];

const withRow = (index: number, patch: Partial<StoredJudgmentFacts>): StoredJudgmentFacts[] =>
  rows().map((row, i) => (i === index ? { ...row, ...patch } : row));

describe('verifyJudgmentsAgainstReport', () => {
  it('accepts rows that agree with the report (insufficient dimensions keep null, citations compare as sets)', () => {
    expect(verifyJudgmentsAgainstReport(report, rows())).toEqual({ ok: true });
  });

  it.each([
    ['a changed score', withRow(0, { score: 1 }), 'score'],
    ['a score one canonical step away (7.0001)', withRow(0, { score: 7.0001 }), 'score'],
    [
      'a score that rounds into the next bucket (7.00005 → 7.0001)',
      withRow(0, { score: 7.00005 }),
      'score',
    ],
    ['a non-finite score', withRow(0, { score: Number.NaN }), 'score'],
    ['an infinite score', withRow(0, { score: Number.POSITIVE_INFINITY }), 'score'],
    ['a scored row without a number', withRow(0, { score: null }), 'score'],
    ['a number on an insufficient dimension (even zero)', withRow(1, { score: 0 }), 'score'],
    [
      'a scored row for an insufficient dimension',
      withRow(1, { outcomeKind: 'scored' }),
      'outcome_state',
    ],
    [
      'an insufficient row for an assessed dimension',
      withRow(0, { outcomeKind: 'insufficient_evidence', score: null }),
      'outcome_state',
    ],
    [
      'a non-scored disposition for an assessed dimension',
      withRow(0, { disposition: 'no_candidate_evidence' }),
      'disposition',
    ],
    [
      'a scored disposition for an insufficient dimension',
      withRow(1, { disposition: 'scored' }),
      'disposition',
    ],
    ['a citation removed', withRow(0, { citationEvidenceIds: [E1] }), 'citations'],
    [
      'a citation added to a dimension that cited nothing',
      withRow(2, { citationEvidenceIds: [E1] }),
      'citations',
    ],
    ['a citation duplicated', withRow(0, { citationEvidenceIds: [E1, E2, E2] }), 'citations'],
    ['a different citation', withRow(0, { citationEvidenceIds: [E1, E1] }), 'citations'],
  ] as const)('refuses %s', (_label, input, mismatch) => {
    expect(verifyJudgmentsAgainstReport(report, input)).toEqual({ ok: false, mismatch });
  });

  it('refuses a missing, an extra and a duplicated dimension', () => {
    expect(verifyJudgmentsAgainstReport(report, rows().slice(1))).toEqual({
      ok: false,
      mismatch: 'dimension_set',
    });
    expect(
      verifyJudgmentsAgainstReport(report, [
        ...rows(),
        { ...rows()[2], dimensionId: 'a.extra' } as StoredJudgmentFacts,
      ]),
    ).toEqual({ ok: false, mismatch: 'dimension_set' });
    expect(
      verifyJudgmentsAgainstReport(report, [
        ...rows().slice(0, 2),
        rows()[1] as StoredJudgmentFacts,
      ]),
    ).toEqual({ ok: false, mismatch: 'dimension_duplicated' });
  });

  it('every mismatch reason is reachable (the closed list has no dead entry)', () => {
    const reached = new Set<string>();
    for (const input of [
      withRow(0, { score: 1 }),
      withRow(0, { outcomeKind: 'insufficient_evidence', score: null }),
      withRow(0, { disposition: 'no_candidate_evidence' }),
      withRow(0, { citationEvidenceIds: [] }),
      rows().slice(1),
      [...rows().slice(0, 2), rows()[1] as StoredJudgmentFacts],
    ]) {
      const result = verifyJudgmentsAgainstReport(report, input);
      if (!result.ok) reached.add(result.mismatch);
    }
    expect([...reached].sort()).toEqual([...JUDGMENT_MISMATCH_VALUES].sort());
  });
});

describe('attributeDisposition (who decided that a dimension has no number)', () => {
  it('attributes every disposition, and never calls an insufficiency "valid"', () => {
    const table = Object.fromEntries(
      UNIT_DISPOSITION_VALUES.map((value) => [value, attributeDisposition(value)]),
    );
    expect(table).toEqual({
      scored: 'scored',
      assessor_reported_insufficient: 'insufficient_by_assessor',
      no_candidate_evidence: 'insufficient_by_code',
      no_satisfiable_need: 'insufficient_by_code',
      no_official_requirement_available: 'insufficient_by_code',
      event_reference_only: 'insufficient_by_code',
      no_project_derived_citation: 'insufficient_by_code',
      no_applicable_context_cited: 'insufficient_by_code',
      no_declared_need_satisfied: 'insufficient_by_code',
      marked_insufficient_by_critic: 'insufficient_by_critic',
      assessor_output_invalid: 'technical',
      critic_unavailable: 'technical',
      provider_refused: 'technical',
      official_requirement_omitted_by_limit: 'technical',
    });
    expect(JSON.stringify(table)).not.toContain('valid_');
  });
});

describe('canonical score precision (the report rounds ONCE, half-up, to four decimals on the decimal a number prints as)', () => {
  const reportOf = (scoreOnScale: number) =>
    ({
      dimensions: [{ id: 'a.one', state: 'assessed', scoreOnScale, citedEvidenceIds: [E1] }],
    }) as unknown as ScoreReport;
  const rowOf = (score: number | null): StoredJudgmentFacts[] => [
    {
      dimensionId: 'a.one',
      outcomeKind: 'scored',
      score,
      disposition: 'scored',
      citationEvidenceIds: [E1],
    },
  ];

  it.each([
    [0, 0],
    [7, 7],
    [10, 10],
    [7.5, 7.5],
    [7.25, 7.25],
    [7.125, 7.125],
    [7.1234, 7.1234],
    [7.33333, 7.3333],
    [7.12345, 7.1235], // half-up on the printed decimal, not on the binary double
    [6.666666666666667, 6.6667],
    [3.3333333333333335, 3.3333],
    [0.00005, 0.0001],
    [0.00004999, 0],
    [9.99995, 10],
    [9.99994999, 9.9999],
    [1.00005, 1.0001],
    [2.675, 2.675],
    [1e-7, 0],
    [5e-5, 0.0001],
    [-0, 0],
    [-0.00004, 0],
  ])(
    'canonical(%j) = %j, and a row with that raw score verifies against a report with that number',
    (raw, canonical) => {
      expect(canonicalReportedScore(raw)).toBe(canonical);
      expect(Object.is(canonicalReportedScore(-0), 0)).toBe(true); // never negative zero
      expect(verifyJudgmentsAgainstReport(reportOf(canonical), rowOf(raw))).toEqual({ ok: true });
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'a value that cannot be a score (%s) has no canonical form and never verifies',
    (raw) => {
      expect(canonicalReportedScore(raw)).toBeNull();
      expect(verifyJudgmentsAgainstReport(reportOf(7), rowOf(raw))).toEqual({
        ok: false,
        mismatch: 'score',
      });
    },
  );

  it('DOCUMENTED EQUIVALENCE CLASS: two raw values in the same four-decimal bucket are indistinguishable (7.33333 and 7.33334 are both 7.3333)', () => {
    expect(canonicalReportedScore(7.33333)).toBe(canonicalReportedScore(7.33334));
    expect(verifyJudgmentsAgainstReport(reportOf(7.3333), rowOf(7.33334))).toEqual({ ok: true });
    // …but the next bucket is not
    expect(verifyJudgmentsAgainstReport(reportOf(7.3333), rowOf(7.33335))).toEqual({
      ok: false,
      mismatch: 'score',
    });
  });

  it('a material change is refused whatever the raw representation (no epsilon)', () => {
    expect(verifyJudgmentsAgainstReport(reportOf(7.3333), rowOf(1))).toEqual({
      ok: false,
      mismatch: 'score',
    });
    expect(verifyJudgmentsAgainstReport(reportOf(7.3333), rowOf(7.3334))).toEqual({
      ok: false,
      mismatch: 'score',
    });
    expect(verifyJudgmentsAgainstReport(reportOf(7.3333), rowOf(null))).toEqual({
      ok: false,
      mismatch: 'score',
    });
  });

  it('a judged value that M4 did not use (no_usable_citation) is a legitimate scored row with a finite number the report does not carry', () => {
    const report = {
      dimensions: [
        {
          id: 'a.one',
          state: 'insufficient_evidence',
          reason: 'no_usable_citation',
          citedEvidenceIds: [E1],
        },
      ],
    } as unknown as ScoreReport;
    expect(verifyJudgmentsAgainstReport(report, rowOf(7.33333))).toEqual({ ok: true });
    expect(verifyJudgmentsAgainstReport(report, rowOf(null))).toEqual({
      ok: false,
      mismatch: 'score',
    });
    expect(verifyJudgmentsAgainstReport(report, rowOf(Number.NaN))).toEqual({
      ok: false,
      mismatch: 'score',
    });
    // the row must still say "scored": an insufficient row cannot explain a no_usable_citation report
    expect(
      verifyJudgmentsAgainstReport(report, [
        {
          dimensionId: 'a.one',
          outcomeKind: 'insufficient_evidence',
          score: null,
          disposition: 'no_candidate_evidence',
          citationEvidenceIds: [E1],
        },
      ]),
    ).toEqual({ ok: false, mismatch: 'outcome_state' });
    // citations are still checked
    expect(
      verifyJudgmentsAgainstReport(report, [
        {
          dimensionId: 'a.one',
          outcomeKind: 'scored',
          score: 7,
          disposition: 'scored',
          citationEvidenceIds: [],
        },
      ]),
    ).toEqual({ ok: false, mismatch: 'citations' });
  });
});
