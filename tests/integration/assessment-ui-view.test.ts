import type {
  ScoreReport,
  AssessmentDetail,
  AssessmentListResponse,
  AssessmentRunView,
} from '../../packages/schemas/src/index.js';
import { describe, expect, it } from 'vitest';
import {
  classifyOverall,
  classifyPage,
  explainFailure,
  formatRatio,
  formatScore10,
  formatScoreOnRubric,
  isTenPointScale,
  relativeDimensions,
  scaleExplanation,
  runToExplain,
  WITHHELD_GUIDANCE,
  withheldGuidance,
} from '../../apps/web/lib/assessment-view.js';
import {
  JUDGMENT_MISMATCH_VALUES,
  STORED_REPORT_CHECKS,
} from '../../packages/assessment/src/index.js';

const usage: AssessmentRunView['usage'] = {
  basis: 'simulated',
  stageExecutions: 0,
  providerCalls: 0,
  simulated: {
    stageExecutions: 0,
    reportedInputTokens: 0,
    reportedOutputTokens: 0,
    notionalCostNanoUsd: 0,
  },
  attemptsStarted: 0,
  settledCalls: 0,
  unknownCalls: 0,
  releasedCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costNanoUsd: 0,
};

function run(overrides: Partial<AssessmentRunView>): AssessmentRunView {
  return {
    id: 'r1',
    projectId: 'p',
    state: 'failed',
    mode: 'assess',
    failureCategory: 'provider_error',
    failureCode: null,
    stageReached: null,
    providerMode: 'replay',
    replayDemonstration: true,
    createdAt: '2026-01-02T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    assessmentId: null,
    usage,
    guard: {} as unknown as AssessmentRunView['guard'],
    coverage: {
      status: 'not_recorded',
      verified: false,
      verdict: null,
      concerns: [],
      partialCapture: false,
      missingSources: [],
    },
    ...overrides,
  };
}

function list(overrides: Partial<AssessmentListResponse>): AssessmentListResponse {
  return {
    assessments: [],
    activeRun: null,
    latestRun: null,
    launch: { available: true, providerMode: 'replay', notice: 'n' },
    notice: 'x' as AssessmentListResponse['notice'],
    ...overrides,
  };
}

function detail(overall: unknown, verified = true): AssessmentDetail {
  return {
    verified,
    report: verified ? { overall } : null,
  } as unknown as AssessmentDetail;
}

describe('assessment page state (classification only: no number is ever produced)', () => {
  it('distinguishes the seven UI states', () => {
    expect(classifyPage(list({}), null)).toBe('none');
    expect(classifyPage(list({ activeRun: run({ state: 'running' }) }), null)).toBe('in_progress');
    expect(classifyPage(list({ latestRun: run({ state: 'failed' }) }), null)).toBe('run_failed');
    expect(classifyPage(list({ latestRun: run({ state: 'cancelled' }) }), null)).toBe('run_failed');
    expect(classifyOverall(detail({ state: 'scored' }))).toBe('scored');
    expect(classifyOverall(detail({ state: 'scored_partial' }))).toBe('scored_partial');
    expect(classifyOverall(detail({ state: 'insufficient_evidence' }))).toBe(
      'insufficient_evidence',
    );
    expect(classifyOverall(detail({ state: 'not_computed' }))).toBe('insufficient_evidence');
    expect(classifyOverall(detail(null, false))).toBe('unverified');
  });

  it('classifies an unverified assessment as unverified however much content it carries (P6A-R1)', () => {
    // verified=false with a report that looks perfectly scored: the flag wins, never the content
    expect(classifyOverall(detail({ state: 'scored' }, false))).toBe('unverified');
    const hostile = {
      verified: false,
      report: { overall: { state: 'scored', score10: 10 } },
    } as unknown as AssessmentDetail;
    expect(classifyOverall(hostile)).toBe('unverified');
    expect(classifyPage(list({ assessments: [{ id: 'a' } as never] }), hostile)).toBe('unverified');
    // verified=true without a report is not a score of zero
    expect(classifyOverall({ verified: true, report: null } as unknown as AssessmentDetail)).toBe(
      'unverified',
    );
    // an unknown overall state is never promoted to a scored one
    expect(classifyOverall(detail({ state: 'something_new' }))).toBe('insufficient_evidence');
  });

  it('never presents a failed run as a success, and keeps a failure newer than the last assessment visible', () => {
    const failed = run({ id: 'r2', state: 'failed', createdAt: '2026-01-03T00:00:00.000Z' });
    const older = {
      id: 'a1',
      runId: 'r1',
      createdAt: '2026-01-02T00:00:00.000Z',
    } as AssessmentListResponse['assessments'][number];
    expect(runToExplain(list({ assessments: [older], latestRun: failed }))).toBe(failed);
    // a failure older than the newest assessment no longer hides it
    expect(
      runToExplain(
        list({
          assessments: [{ ...older, createdAt: '2026-01-04T00:00:00.000Z' }],
          latestRun: failed,
        }),
      ),
    ).toBeNull();
    expect(explainFailure(failed)).not.toMatch(/success/i);
  });
});

describe('number presentation (D12): canonical precision is shown as it is; percentages round half-up on decimal digits', () => {
  /** An independent oracle: exact decimal arithmetic on the number's digits with BigInt, written differently from the implementation. */
  function oraclePercent(value: number): string {
    const text = String(value);
    const [whole = '0', fraction = ''] = text.split('.');
    // scale to 1e-6 integer units, then half-up to whole percent (1e4 units)
    const micro = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
    const percent = (micro * 100n + 500_000n) / 1_000_000n;
    return `${percent.toString()}%`;
  }

  it.each([
    [7, '7.0'],
    [7.5, '7.5'],
    [7.05, '7.05'], // toFixed(1) gave "7.0" (binary rounding)
    [8.45, '8.45'], // toFixed(1) gave "8.4"
    [2.675, '2.675'],
    [7.3333, '7.3333'],
    [6.6667, '6.6667'],
    [9.9999, '9.9999'],
    [10, '10.0'],
    [0, '0.0'],
    [0.0001, '0.0001'],
    [-0, '0.0'],
  ])('formatScore10(%s) is the canonical decimal text %s, never re-rounded', (value, expected) => {
    expect(formatScore10(value)).toBe(expected);
  });

  it('shows exactly the digits the report holds: formatScore10 never changes a four-decimal score', () => {
    for (let i = 0; i <= 100_000; i += 137) {
      const value = i / 10_000; // every value is a four-decimal canonical score
      const shown = formatScore10(value);
      expect(Number(shown)).toBe(value);
    }
  });

  it.each([
    [0, '0%'],
    [1, '100%'],
    [0.35, '35%'],
    [0.285, '29%'], // Math.round(0.285 * 100) is 28
    [0.145, '15%'], // Math.round(0.145 * 100) is 14
    [0.7, '70%'],
    [0.7049, '70%'],
    [0.705, '71%'],
    [0.0049, '0%'],
    [0.005, '1%'],
    [0.9999, '100%'],
  ])('formatRatio(%s) = %s', (value, expected) => {
    expect(formatRatio(value)).toBe(expected);
  });

  it('agrees with the independent oracle on every four-decimal ratio', () => {
    for (let i = 0; i <= 10_000; i += 1) {
      const value = i / 10_000;
      expect(formatRatio(value), String(value)).toBe(oraclePercent(value));
    }
  });
});

describe('relative highs and lows (DG-5)', () => {
  const assessed = (id: string, score10: number) => ({
    id,
    name: id,
    state: 'assessed',
    score10,
    scoreOnScale: score10,
    confidence: 0.3,
  });
  const missing = (id: string) => ({
    id,
    name: id,
    state: 'insufficient_evidence',
    reason: 'assessor_reported_insufficient',
  });
  const reportOf = (...dimensions: unknown[]) => ({ dimensions }) as unknown as ScoreReport;
  const ids = (entries: readonly { dimensionId: string }[]) =>
    entries.map((entry) => entry.dimensionId);

  it('needs at least two assessed dimensions', () => {
    expect(relativeDimensions(reportOf(), [])).toMatchObject({ kind: 'not_enough', assessed: 0 });
    expect(relativeDimensions(reportOf(assessed('a', 5)), [])).toMatchObject({
      kind: 'not_enough',
      assessed: 1,
      notAssessed: 0,
    });
    expect(
      relativeDimensions(reportOf(assessed('a', 5), missing('b'), missing('c')), []),
    ).toMatchObject({
      kind: 'not_enough',
      assessed: 1,
      notAssessed: 2,
    });
  });

  it('reports "all equal" instead of inventing a high and a low', () => {
    expect(
      relativeDimensions(
        reportOf(assessed('a', 6.6667), assessed('b', 6.6667), assessed('c', 6.6667)),
        [],
      ),
    ).toMatchObject({
      kind: 'all_equal',
      assessed: 3,
      score10: 6.6667,
    });
  });

  it('picks the extremes, lists every tie in a stable order, and never counts a missing dimension as zero', () => {
    const result = relativeDimensions(
      reportOf(
        assessed('d', 8),
        assessed('a', 8),
        assessed('c', 2),
        assessed('b', 5),
        missing('z'),
      ),
      [],
    );
    expect(result.kind).toBe('ranked');
    if (result.kind !== 'ranked') return;
    expect(ids(result.highest)).toEqual(['a', 'd']);
    expect(ids(result.lowest)).toEqual(['c']);
    expect(result.assessed).toBe(4);
    expect(result.notAssessed).toBe(1);
    // the missing dimension is neither the lowest nor part of the comparison
    expect(ids(result.lowest)).not.toContain('z');
  });

  it('is exact: two scores that differ only in the fourth decimal are different, equal canonical scores are tied', () => {
    const result = relativeDimensions(reportOf(assessed('a', 7.3333), assessed('b', 7.3334)), []);
    expect(result.kind === 'ranked' && ids(result.highest)).toEqual(['b']);
    expect(result.kind === 'ranked' && ids(result.lowest)).toEqual(['a']);
  });

  it('is deterministic and independent of the order of the dimensions', () => {
    const dims = [assessed('a', 3), assessed('b', 9), assessed('c', 9), assessed('d', 1)];
    const forward = relativeDimensions(reportOf(...dims), []);
    const reversed = relativeDimensions(reportOf(...[...dims].reverse()), []);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });
});

describe('withheld-assessment guidance (D9)', () => {
  it('has a sentence for EVERY failure code the verifier and the read model can emit', () => {
    const codes = [
      ...STORED_REPORT_CHECKS,
      'report_schema',
      'unverifiable',
      ...JUDGMENT_MISMATCH_VALUES.map((reason) => `judgment_mismatch_${reason}`),
    ];
    expect(Object.keys(WITHHELD_GUIDANCE).sort()).toEqual([...codes].sort());
    for (const code of codes) {
      const { reason, action } = withheldGuidance(code);
      expect(reason).toContain('integrity check');
      expect(reason).toContain('none of it is shown');
      expect(action).toContain('Reassess');
    }
  });

  it('an unknown or missing code still gets a safe sentence that does not echo the code', () => {
    for (const code of ['<script>alert(1)</script>', 'something_new', null]) {
      const { reason } = withheldGuidance(code);
      expect(reason).toContain('integrity check');
      expect(reason).not.toContain('script');
      expect(reason).not.toContain('something_new');
    }
  });

  it('never suggests that the withheld content is probably fine', () => {
    for (const text of Object.values(WITHHELD_GUIDANCE)) {
      expect(text.toLowerCase()).not.toMatch(/probably|likely fine|safe to use|minor/);
    }
  });
});

describe('failure explanations by code', () => {
  const failed = (failureCode: string | null, failureCategory: string | null) =>
    run({ state: 'failed', failureCode, failureCategory });

  it('explains a replay miss as missing recorded demonstration data, not a provider outage', () => {
    const text = explainFailure(failed('replay_miss', 'provider_error'));
    expect(text).toContain('no recorded answer');
    expect(text).not.toContain('provider could not');
  });

  it('explains the pipeline pre-check codes, and falls back to the category for an unknown code', () => {
    expect(
      explainFailure(failed('fallback_anchors_not_approved', 'domain_validation_failed')),
    ).toContain('official overall rubric');
    expect(
      explainFailure(failed('no_context_reference_evidence', 'domain_validation_failed')),
    ).toContain('known limitation');
    expect(explainFailure(failed('something_new', 'timeout'))).toContain('time limit');
    expect(explainFailure(failed(null, null))).toContain('did not complete');
  });
});

describe('P6B-beta1: the rubric’s own scale (pure formatter)', () => {
  it('keeps the plain form for a 0-10 scale and labels both figures otherwise', () => {
    expect(isTenPointScale({ min: 0, max: 10 })).toBe(true);
    expect(isTenPointScale({ min: 1, max: 10 })).toBe(false);
    expect(formatScoreOnRubric(7, 7, { min: 0, max: 10 })).toBe('7.0 / 10');
    expect(formatScoreOnRubric(0, 1, { min: 1, max: 5 })).toBe(
      '1.0 on the rubric’s scale of 1 to 5 (0.0 / 10 normalized)',
    );
    expect(formatScoreOnRubric(10, 5, { min: 1, max: 5 })).toBe(
      '5.0 on the rubric’s scale of 1 to 5 (10.0 / 10 normalized)',
    );
    expect(formatScoreOnRubric(7.33333, 4.3333, { min: 1, max: 5 })).toBe(
      '4.3333 on the rubric’s scale of 1 to 5 (7.33333 / 10 normalized)',
    );
  });

  it('is purely presentational: both numbers are printed exactly as given, whatever the scale', () => {
    // no combination of stored values is altered, clamped or recomputed by the formatter
    for (const [score10, native] of [
      [0, 1],
      [2.5, 1.5],
      [10, 5],
      [9.99999, 4.99999],
    ] as const) {
      const text = formatScoreOnRubric(score10, native, { min: 1, max: 5 });
      expect(text).toContain(`(${formatScore10(score10)} / 10 normalized)`);
      expect(text.startsWith(formatScore10(native))).toBe(true);
    }
  });

  it('explains the normalization only when the scale is not the plain 0-10 one', () => {
    expect(scaleExplanation({ min: 0, max: 10 })).toBeNull();
    const note = scaleExplanation({ min: 1, max: 5 }) ?? '';
    expect(note).toContain('from 1 (lowest) to 5 (highest)');
    expect(note).toContain('real, low score, not missing evidence');
    expect(note).toContain('has no number at all');
  });

  it('the relative comparison carries the native score of each dimension', () => {
    const report = {
      rubric: { scale: { min: 1, max: 5 } },
      dimensions: [
        { id: 'd.a', name: 'A', state: 'assessed', score10: 10, scoreOnScale: 5, confidence: 0.3 },
        { id: 'd.b', name: 'B', state: 'assessed', score10: 0, scoreOnScale: 1, confidence: 0.3 },
      ],
    } as unknown as ScoreReport;
    const result = relativeDimensions(report, []);
    expect(result.kind).toBe('ranked');
    if (result.kind === 'ranked') {
      expect(result.highest[0]?.scoreOnScale).toBe(5);
      expect(result.lowest[0]?.scoreOnScale).toBe(1);
    }
  });
});
