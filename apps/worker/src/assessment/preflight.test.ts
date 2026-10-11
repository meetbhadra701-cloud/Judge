import { PRICES_V1 } from '@judge-copilot/llm';
import { AssessmentRunLimits, type AssessmentRunLimits as Limits } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import { artifact } from '../testing/artifacts.js';
import { fitBatches, variableByteBudget } from './extract.js';
import { ladder, plannedCalls, preflight, projectCounts, type PlanInputs } from './preflight.js';

/*
 * The sizing arithmetic of design §12.3.4 (owner correction C2), recomputed here from the table's own inputs: the code must reproduce the
 * design's nominal and planned call counts exactly.
 */
const SCENARIOS: [string, PlanInputs, { nominal: number; planned: number }][] = [
  // The design's table prints a re-run allowance of 8 for this row (planned 90, headroom 60) although its own rule for the fallback
  // rubric is 8 assessor + 8 critic = 16 (as in the typical and large rows). The code implements the stated RULE: planned 98, headroom 52.
  [
    'small (fallback)',
    {
      statementPassages: 18,
      interpretPassages: 45,
      claims: 12,
      evidence: 25,
      relations: 18,
      units: 31,
      rubric: 'fallback',
      extractionReused: false,
    },
    { nominal: 74, planned: 98 },
  ],
  [
    'typical (fallback)',
    {
      statementPassages: 66,
      interpretPassages: 165,
      claims: 45,
      evidence: 70,
      relations: 68,
      units: 36,
      rubric: 'fallback',
      extractionReused: false,
    },
    { nominal: 102, planned: 129 },
  ],
  [
    'large (fallback)',
    {
      statementPassages: 120,
      interpretPassages: 270,
      claims: 80,
      evidence: 100,
      relations: 100,
      units: 36,
      rubric: 'fallback',
      extractionReused: false,
    },
    { nominal: 115, planned: 143 },
  ],
  [
    'typical, official 5 criteria',
    {
      statementPassages: 66,
      interpretPassages: 165,
      claims: 45,
      evidence: 70,
      relations: 68,
      units: 5,
      rubric: 'official',
      extractionReused: false,
    },
    { nominal: 40, planned: 48 },
  ],
];

describe('plannedCalls reproduces the design sizing table', () => {
  it.each(SCENARIOS)('%s', (_name, input, expected) => {
    const plan = plannedCalls(input);
    expect({ nominal: plan.nominal, planned: plan.planned }).toEqual(expected);
  });

  it('headroom to the 150-attempt guard (the design states 60 / 21 / 7 / 102; the small row differs, see above)', () => {
    const headroom = SCENARIOS.map(([, input]) => 150 - plannedCalls(input).planned);
    expect(headroom).toEqual([52, 21, 7, 102]);
  });

  it('a reused extraction leaves only the assessment calls', () => {
    const [, typical] = SCENARIOS[3] as (typeof SCENARIOS)[number];
    const plan = plannedCalls({ ...typical, extractionReused: true });
    expect(plan.byStage).toEqual({ dimension_assessment: 5, critic: 5 });
    expect(plan.nominal).toBe(10);
  });

  it('plans no call for a stage that has no input (no passages, no claims)', () => {
    const plan = plannedCalls({
      statementPassages: 0,
      interpretPassages: 4,
      claims: 0,
      evidence: 3,
      relations: 0,
      units: 2,
      rubric: 'official',
      extractionReused: false,
    });
    expect(plan.byStage['claim_extraction']).toBe(0);
    expect(plan.byStage['relation_matching']).toBe(0);
    expect(plan.byStage['contradiction_detection']).toBe(0);
    expect(plan.byStage['unknown_identification']).toBe(0);
  });

  it('projects counts that never exceed the structural caps', () => {
    expect(projectCounts(1_000, 1_000, { claims: 80, evidence: 100 })).toEqual({
      claims: 80,
      evidence: 100,
      relations: 100,
    });
    expect(projectCounts(0, 0, { claims: 80, evidence: 100 })).toEqual({
      claims: 0,
      evidence: 0,
      relations: 0,
    });
  });
});

describe('the reduction ladder', () => {
  const base = { statement: 120_000, source: 240_000, metadata: 30_000 };

  it('lowers the source budget 240K -> 180K -> 120K -> 60K, then the claim and evidence caps by 25% steps to a floor', () => {
    const steps = ladder(base);
    expect(steps.map((s) => s.budgets.source)).toEqual([
      240_000, 180_000, 120_000, 60_000, 60_000, 60_000, 60_000, 60_000,
    ]);
    expect(steps.map((s) => s.claimsCap)).toEqual([80, 80, 80, 80, 60, 45, 33, 25]);
    expect(steps.map((s) => s.evidenceCap)).toEqual([100, 100, 100, 100, 75, 56, 42, 31]);
    expect(
      steps.every((s) => s.budgets.statement === 120_000 && s.budgets.metadata === 30_000),
    ).toBe(true);
    expect(steps.map((s) => s.step)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('never goes below the floor, whatever the configured budget', () => {
    const steps = ladder({ statement: 1_000, source: 1_000, metadata: 1_000 });
    expect(
      steps.every((s) => s.budgets.source >= 1_000 && s.claimsCap >= 20 && s.evidenceCap >= 25),
    ).toBe(true);
  });
});

describe('preflight', () => {
  const body = (n: number) =>
    Array.from({ length: n }, (_, i) => `function f${String(i)}() { return ${String(i)}; }`).join(
      '\n',
    );
  const artifacts = [
    artifact({
      sourceType: 'devpost',
      key: 'submission.txt',
      kind: 'submission_text',
      text: 'HydroTrack\nIt works offline.\n',
    }),
    ...Array.from({ length: 8 }, (_, i) =>
      artifact({ sourceType: 'github', key: `files/src/m${String(i)}.ts`, text: body(900) }),
    ),
  ];
  const models = {
    extraction: 'claude-haiku-5-5',
    assessment: 'claude-sonnet-5-5',
    critic: 'claude-sonnet-5-5',
  };
  const run = (limits: Limits, extractionExists = false) =>
    preflight({
      artifacts,
      budgets: { statement: 120_000, source: 240_000, metadata: 30_000 },
      units: 5,
      rubric: 'official',
      limits,
      models,
      prices: PRICES_V1,
      extractionExists: () => Promise.resolve(extractionExists),
    });

  it('accepts the configured budgets when the projected run fits the default limits', async () => {
    const result = await run(AssessmentRunLimits.parse({}));
    expect(result.ok && result.reductionSteps).toBe(0);
    expect(result.ok && result.calls.planned).toBeLessThanOrEqual(150);
  });

  it('walks down the ladder until the projection fits, recording how far it had to go', async () => {
    const fits = await run(AssessmentRunLimits.parse({}));
    if (!fits.ok) throw new Error('baseline');
    const tight = await run(AssessmentRunLimits.parse({ maxCalls: fits.calls.planned - 1 }));
    // fewer passages shrink the plan: either a later step fits or none does, and a plan that was accepted always fits its limits
    if (tight.ok) {
      expect(tight.reductionSteps).toBeGreaterThan(0);
      expect(tight.calls.planned).toBeLessThanOrEqual(fits.calls.planned - 1);
    } else {
      expect(tight.reason).toBe('plan_exceeds_limits');
    }
  });

  it('fails without spending when even the floor does not fit', async () => {
    const result = await run(AssessmentRunLimits.parse({ maxCalls: 3 }));
    expect(result).toMatchObject({ ok: false, reason: 'plan_exceeds_limits' });
  });

  it('an existing extraction costs only the assessment calls, so a limit that refuses a fresh run can admit a reused one', async () => {
    const limits = AssessmentRunLimits.parse({ maxCalls: 15 });
    expect((await run(limits, false)).ok).toBe(false);
    const reused = await run(limits, true);
    expect(reused.ok && reused.reused).toBe(true);
    expect(reused.ok && reused.calls.planned).toBe(10 + 4 + 1);
  });

  it('refuses a model without a price (the guard cannot bound what it cannot price)', async () => {
    const result = await preflight({
      artifacts,
      budgets: { statement: 120_000, source: 240_000, metadata: 30_000 },
      units: 2,
      rubric: 'official',
      limits: AssessmentRunLimits.parse({}),
      models: { ...models, assessment: 'unpriced-model' },
      prices: PRICES_V1,
      extractionExists: () => Promise.resolve(false),
    });
    expect(result).toMatchObject({ ok: false, reason: 'unpriced_model' });
  });
});

describe('batching', () => {
  it('splits by count and by bytes, and an oversized item goes alone', () => {
    const items = ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(5_000), 'd'.repeat(100)];
    const size = (text: string) => text.length;
    expect(fitBatches(items, 2, 100_000, size).map((b) => b.length)).toEqual([2, 2]);
    expect(fitBatches(items, 10, 1_200, size).map((b) => b.map((x) => x[0]).join(''))).toEqual([
      'ab',
      'c',
      'd',
    ]);
    expect(fitBatches([], 5, 100, size)).toEqual([]);
  });

  it('keeps one call under the per-call input bound', () => {
    const limits = AssessmentRunLimits.parse({});
    expect(variableByteBudget(limits)).toBe(100_000 - 2_000 - 8_000);
    expect(
      variableByteBudget(AssessmentRunLimits.parse({ maxReservedInputTokensPerCall: 1 })),
    ).toBe(8_000);
  });
});
