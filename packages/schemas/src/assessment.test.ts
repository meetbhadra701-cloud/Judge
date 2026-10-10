import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_RUN_FAILURE_CATEGORY_VALUES,
  ASSESSMENT_CALL_TIMEOUT_MS,
  ASSESSMENT_RUN_FAILURE_CATEGORY_VALUES,
  ASSESSMENT_RUN_LIMIT_DEFAULTS,
  ASSESSMENT_RUN_LIMIT_MAXIMA,
  ASSESSMENT_STAGE_OUTPUT_SCHEMAS,
  ASSESSMENT_STAGE_VALUES,
  AssessmentRunLimits,
  LLM_FAILURE_CATEGORY_VALUES,
  parseStageOutput,
  PriceTable,
  Quote,
  type AssessmentStage,
} from './index.js';

/*
 * Gate 1 (shape) for every model-backed stage: accept tables, reject tables, smuggled keys, handle rules,
 * quote rules, hostile numbers and the redaction of validation issues.
 */

const valid: Record<AssessmentStage, unknown> = {
  claim_extraction: {
    claims: [
      {
        ref: 'c1',
        text: 'The app tracks water intake.',
        passage: 'P-0001',
        quote: 'tracks water intake daily',
      },
    ],
  },
  evidence_interpretation: {
    evidence: [
      {
        ref: 'e1',
        text: 'The handler rejects non-positive amounts.',
        passage: 'P-0002',
        quote: 'if (amount <= 0) throw',
      },
    ],
  },
  fidelity_review: { verdicts: [{ item: 'C-001', verdict: 'faithful' }] },
  relation_matching: { relations: [{ claim: 'C-001', evidence: 'E-002', type: 'supports' }] },
  relation_verification: { verdicts: [{ pair: 'X-001', verdict: 'supports' }] },
  contradiction_detection: {
    contradictions: [
      {
        sideA: { type: 'claim', handle: 'C-001' },
        sideB: { type: 'evidence', handle: 'E-002' },
        description:
          'The README describes offline mode, while the shown code requires a network call.',
      },
    ],
  },
  unknown_identification: {
    unknowns: [
      {
        unknownType: 'unverifiable',
        text: 'Whether the demo uses live data cannot be established from the captured text.',
        claims: ['C-001'],
        evidence: [],
      },
    ],
  },
  dimension_assessment: {
    dimensionId: 'technical_execution.implementation_depth',
    outcome: { kind: 'scored', score: 6.5 },
    citations: [
      { evidence: 'E-002', directness: 'direct', specificity: 'partial', note: 'validation code' },
    ],
    rationale: 'The shown handler implements validation along the core path.',
    limitations: ['sampled_source'],
  },
  critic: {
    unit: 'technical_execution.implementation_depth',
    findings: [
      {
        code: 'team_claim_overreliance',
        severity: 'minor',
        evidence: ['E-001'],
        note: 'one statement',
      },
    ],
  },
};

const clone = <T>(value: T): T => structuredClone(value);

describe('stage output schemas: accept', () => {
  it('covers every stage with a schema and a valid fixture', () => {
    expect(Object.keys(ASSESSMENT_STAGE_OUTPUT_SCHEMAS).sort()).toEqual(
      [...ASSESSMENT_STAGE_VALUES].sort(),
    );
    expect(ASSESSMENT_STAGE_VALUES).toHaveLength(9);
  });

  it.each(ASSESSMENT_STAGE_VALUES)('accepts a well-formed %s output', (stage) => {
    const result = parseStageOutput(stage, valid[stage]);
    expect(result.ok).toBe(true);
  });

  it('accepts empty result lists (a window with nothing to extract is allowed)', () => {
    expect(parseStageOutput('claim_extraction', { claims: [] }).ok).toBe(true);
    expect(parseStageOutput('critic', { unit: 'a.b', findings: [] }).ok).toBe(true);
  });

  it('accepts an insufficient_evidence judgment with no citations', () => {
    const output = clone(valid.dimension_assessment) as Record<string, unknown>;
    output['outcome'] = { kind: 'insufficient_evidence' };
    output['citations'] = [];
    expect(parseStageOutput('dimension_assessment', output).ok).toBe(true);
  });
});

describe('stage output schemas: shape rejections', () => {
  const edits: [AssessmentStage, string, (value: Record<string, unknown>) => void][] = [
    ['claim_extraction', 'missing quote', (v) => delete firstOf(v, 'claims')['quote']],
    [
      'claim_extraction',
      'passage is not a handle',
      (v) => (firstOf(v, 'claims')['passage'] = 'passage-1'),
    ],
    [
      'claim_extraction',
      'a UUID instead of a passage handle',
      (v) => (firstOf(v, 'claims')['passage'] = '3f2b8f0e-6a38-4c0b-9a6e-1f1c3d6c4a11'),
    ],
    ['claim_extraction', 'text is a number', (v) => (firstOf(v, 'claims')['text'] = 7)],
    ['claim_extraction', 'ref with uppercase', (v) => (firstOf(v, 'claims')['ref'] = 'C1')],
    ['claim_extraction', 'empty claim text', (v) => (firstOf(v, 'claims')['text'] = '   ')],
    [
      'evidence_interpretation',
      'kind supplied by the model',
      (v) => (firstOf(v, 'evidence')['kind'] = 'fact'),
    ],
    [
      'evidence_interpretation',
      'quote too short',
      (v) => (firstOf(v, 'evidence')['quote'] = 'short'),
    ],
    [
      'fidelity_review',
      'unknown verdict',
      (v) => (firstOf(v, 'verdicts')['verdict'] = 'mostly_faithful'),
    ],
    ['fidelity_review', 'item is a pair handle', (v) => (firstOf(v, 'verdicts')['item'] = 'X-001')],
    [
      'relation_matching',
      'unknown relation type',
      (v) => (firstOf(v, 'relations')['type'] = 'refutes'),
    ],
    [
      'relation_matching',
      'claim handle with evidence prefix',
      (v) => (firstOf(v, 'relations')['claim'] = 'E-001'),
    ],
    [
      'relation_verification',
      'verdict outside the vocabulary',
      (v) => (firstOf(v, 'verdicts')['verdict'] = 'maybe'),
    ],
    [
      'contradiction_detection',
      'side type and handle disagree',
      (v) =>
        ((firstOf(v, 'contradictions')['sideA'] as Record<string, unknown>)['handle'] = 'E-009'),
    ],
    [
      'contradiction_detection',
      'side type is an unknown node type',
      (v) =>
        ((firstOf(v, 'contradictions')['sideA'] as Record<string, unknown>)['type'] = 'unknown'),
    ],
    [
      'unknown_identification',
      'model-authored missing unknown',
      (v) => (firstOf(v, 'unknowns')['unknownType'] = 'missing'),
    ],
    [
      'unknown_identification',
      'claims is not an array',
      (v) => (firstOf(v, 'unknowns')['claims'] = 'C-001'),
    ],
    [
      'dimension_assessment',
      'score on an insufficient outcome',
      (v) => (v['outcome'] = { kind: 'insufficient_evidence', score: 3 }),
    ],
    [
      'dimension_assessment',
      'scored outcome without a score',
      (v) => (v['outcome'] = { kind: 'scored' }),
    ],
    [
      'dimension_assessment',
      'score is a string',
      (v) => (v['outcome'] = { kind: 'scored', score: '7' }),
    ],
    [
      'dimension_assessment',
      'citation by UUID (evidenceId)',
      (v) =>
        (v['citations'] = [
          {
            evidenceId: '3f2b8f0e-6a38-4c0b-9a6e-1f1c3d6c4a11',
            directness: 'direct',
            specificity: 'exact',
            note: 'x',
          },
        ]),
    ],
    [
      'dimension_assessment',
      'directness outside the vocabulary',
      (v) => (firstOf(v, 'citations')['directness'] = 'very_direct'),
    ],
    ['dimension_assessment', 'missing rationale', (v) => delete v['rationale']],
    ['dimension_assessment', 'empty rationale', (v) => (v['rationale'] = '')],
    ['dimension_assessment', 'over-long rationale', (v) => (v['rationale'] = 'x'.repeat(1_201))],
    [
      'dimension_assessment',
      'unknown limitation code',
      (v) => (v['limitations'] = ['the_team_cheated']),
    ],
    [
      'dimension_assessment',
      'dimension id is not an identifier',
      (v) => (v['dimensionId'] = 'Technical Execution'),
    ],
    ['critic', 'rewritten score', (v) => (v['rewrittenScore'] = 9)],
    ['critic', 'unknown finding code', (v) => (firstOf(v, 'findings')['code'] = 'cheating')],
    [
      'critic',
      'severity outside the vocabulary',
      (v) => (firstOf(v, 'findings')['severity'] = 'fatal'),
    ],
    [
      'critic',
      'finding cites a UUID',
      (v) => (firstOf(v, 'findings')['evidence'] = ['3f2b8f0e-6a38-4c0b-9a6e-1f1c3d6c4a11']),
    ],
  ];

  it.each(edits)('%s: rejects %s', (stage, _label, edit) => {
    const mutated = clone(valid[stage]) as Record<string, unknown>;
    edit(mutated);
    expect(parseStageOutput(stage, mutated).ok).toBe(false);
  });

  it.each([null, undefined, 'text', 7, [], true])(
    'rejects a non-object answer (%j) at every stage',
    (answer) => {
      for (const stage of ASSESSMENT_STAGE_VALUES) {
        expect(parseStageOutput(stage, answer).ok, stage).toBe(false);
      }
    },
  );

  it('rejects over-long lists at every list stage', () => {
    const many = (n: number, item: unknown) => Array.from({ length: n }, () => item);
    const claim = (valid.claim_extraction as { claims: unknown[] }).claims[0];
    expect(parseStageOutput('claim_extraction', { claims: many(26, claim) }).ok).toBe(false);
    expect(parseStageOutput('claim_extraction', { claims: many(25, claim) }).ok).toBe(true);
    const finding = (valid.critic as { findings: unknown[] }).findings[0];
    expect(parseStageOutput('critic', { unit: 'a.b', findings: many(21, finding) }).ok).toBe(false);
  });

  it('rejects an over-long note and control characters in prose', () => {
    const output = clone(valid.dimension_assessment) as Record<string, unknown>;
    firstOf(output, 'citations')['note'] = 'x'.repeat(241);
    expect(parseStageOutput('dimension_assessment', output).ok).toBe(false);
    const withControl = clone(valid.dimension_assessment) as Record<string, unknown>;
    withControl['rationale'] = 'bad \u0000 text';
    expect(parseStageOutput('dimension_assessment', withControl).ok).toBe(false);
  });
});

describe('stage output schemas: smuggled keys are rejected, not ignored', () => {
  const smuggled: Record<string, unknown> = {
    id: '3f2b8f0e-6a38-4c0b-9a6e-1f1c3d6c4a11',
    origin: 'github',
    humanModified: false,
    verificationLevel: 'repo_corroborated',
    score: 10,
    confidence: 1,
    weight: 0.5,
    overall: 9.9,
    snapshotId: '3f2b8f0e-6a38-4c0b-9a6e-1f1c3d6c4a11',
    machine_verified: true,
  };

  it.each(ASSESSMENT_STAGE_VALUES)('%s: rejects every smuggled key at the root', (stage) => {
    for (const [key, value] of Object.entries(smuggled)) {
      const output = clone(valid[stage]) as Record<string, unknown>;
      output[key] = value;
      expect(parseStageOutput(stage, output).ok, `${stage} + ${key}`).toBe(false);
    }
  });

  it.each([
    ['claim_extraction', 'claims'],
    ['evidence_interpretation', 'evidence'],
    ['fidelity_review', 'verdicts'],
    ['relation_matching', 'relations'],
    ['relation_verification', 'verdicts'],
    ['contradiction_detection', 'contradictions'],
    ['unknown_identification', 'unknowns'],
    ['critic', 'findings'],
  ] as const)('%s: rejects every smuggled key inside a list item', (stage, list) => {
    for (const [key, value] of Object.entries(smuggled)) {
      const output = clone(valid[stage]) as Record<string, unknown>;
      firstOf(output, list)[key] = value;
      expect(parseStageOutput(stage, output).ok, `${stage}.${list} + ${key}`).toBe(false);
    }
  });

  it('rejects smuggled keys inside a judgment citation and inside a contradiction side', () => {
    const judgment = clone(valid.dimension_assessment) as Record<string, unknown>;
    firstOf(judgment, 'citations')['verificationLevel'] = 'live_verified';
    expect(parseStageOutput('dimension_assessment', judgment).ok).toBe(false);
    const contradiction = clone(valid.contradiction_detection) as Record<string, unknown>;
    (firstOf(contradiction, 'contradictions')['sideA'] as Record<string, unknown>)['id'] = 'x';
    expect(parseStageOutput('contradiction_detection', contradiction).ok).toBe(false);
  });
});

describe('hostile numbers', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects a non-finite score (%s)',
    (score) => {
      const output = clone(valid.dimension_assessment) as Record<string, unknown>;
      output['outcome'] = { kind: 'scored', score };
      expect(parseStageOutput('dimension_assessment', output).ok).toBe(false);
    },
  );

  it('accepts negative, zero and large finite scores at the SHAPE gate (the rubric scale is a domain rule)', () => {
    for (const score of [-5, 0, 1e6]) {
      const output = clone(valid.dimension_assessment) as Record<string, unknown>;
      output['outcome'] = { kind: 'scored', score };
      expect(parseStageOutput('dimension_assessment', output).ok, String(score)).toBe(true);
    }
  });
});

describe('quotes', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(Quote.safeParse('😀'.repeat(8)).success).toBe(true); // 8 code points, 16 units
    expect(Quote.safeParse('😀'.repeat(7)).success).toBe(false);
    expect(Quote.safeParse('a'.repeat(2_000)).success).toBe(true);
    expect(Quote.safeParse('a'.repeat(2_001)).success).toBe(false);
  });

  it('does not normalize or trim: a quote must stay byte-exact', () => {
    const padded = '  spaced quote text  ';
    const parsed = Quote.safeParse(padded);
    expect(parsed.success && parsed.data).toBe(padded);
    const decomposed = 'café au lait!';
    const result = Quote.safeParse(decomposed);
    expect(result.success && result.data).toBe(decomposed);
  });

  it('rejects lone surrogates and NUL', () => {
    expect(Quote.safeParse(`valid text \ud800`).success).toBe(false);
    expect(Quote.safeParse('valid text \u0000 here').success).toBe(false);
  });
});

describe('validation issues are redacted', () => {
  it('returns paths and Zod codes only, never the offending value', () => {
    const secret = 'SECRET-PROJECT-TEXT-api_key=CANARY-123';
    const output = clone(valid.claim_extraction) as Record<string, unknown>;
    firstOf(output, 'claims')['passage'] = secret;
    firstOf(output, 'claims')['unexpected'] = secret;
    const result = parseStageOutput('claim_extraction', output);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(JSON.stringify(result.issues)).not.toContain('SECRET');
      expect(JSON.stringify(result.issues)).not.toContain('CANARY');
      for (const issue of result.issues) {
        expect(Object.keys(issue).sort()).toEqual(['code', 'path']);
      }
    }
  });

  it('caps the number of issues', () => {
    const claims = Array.from({ length: 25 }, () => ({ nope: 1 }));
    const result = parseStageOutput('claim_extraction', { claims });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeLessThanOrEqual(50);
  });
});

describe('vocabularies and limits', () => {
  it('pins the analysis-run failure categories: budget_exceeded joined them in the P4 migration', () => {
    expect([...ANALYSIS_RUN_FAILURE_CATEGORY_VALUES]).toEqual([
      'provider_error',
      'schema_validation_failed',
      'domain_validation_failed',
      'source_unavailable',
      'timeout',
      'internal_error',
      'budget_exceeded',
    ]);
    expect([...ASSESSMENT_RUN_FAILURE_CATEGORY_VALUES]).toEqual([
      ...ANALYSIS_RUN_FAILURE_CATEGORY_VALUES,
    ]);
  });

  it('pins the provider-neutral failure vocabulary', () => {
    expect([...LLM_FAILURE_CATEGORY_VALUES]).toEqual([
      'timeout',
      'rate_limited',
      'provider_unavailable',
      'refused',
      'truncated',
      'auth',
      'bad_request',
      'cancelled',
      'budget_exceeded',
      'replay_miss',
    ]);
  });

  it('applies the documented defaults and refuses values above the absolute maxima', () => {
    expect(AssessmentRunLimits.parse({})).toEqual(ASSESSMENT_RUN_LIMIT_DEFAULTS);
    expect(ASSESSMENT_RUN_LIMIT_DEFAULTS.maxCalls).toBe(150);
    expect(ASSESSMENT_RUN_LIMIT_DEFAULTS.runWallClockMs).toBe(120 * 60_000);
    expect(ASSESSMENT_RUN_LIMIT_MAXIMA.runWallClockMs).toBe(240 * 60_000);
    expect(ASSESSMENT_CALL_TIMEOUT_MS).toEqual({ default: 120_000, max: 300_000 });
    for (const key of Object.keys(
      ASSESSMENT_RUN_LIMIT_MAXIMA,
    ) as (keyof typeof ASSESSMENT_RUN_LIMIT_MAXIMA)[]) {
      expect(
        AssessmentRunLimits.safeParse({ [key]: ASSESSMENT_RUN_LIMIT_MAXIMA[key] }).success,
        key,
      ).toBe(true);
      expect(
        AssessmentRunLimits.safeParse({ [key]: ASSESSMENT_RUN_LIMIT_MAXIMA[key] + 1 }).success,
        key,
      ).toBe(false);
      expect(AssessmentRunLimits.safeParse({ [key]: 0 }).success, key).toBe(false);
      expect(AssessmentRunLimits.safeParse({ [key]: 1.5 }).success, key).toBe(false);
    }
  });

  it('rejects unknown limit keys', () => {
    expect(AssessmentRunLimits.safeParse({ maxCallz: 5 }).success).toBe(false);
  });

  it('requires integer, dated, versioned prices', () => {
    const base = {
      id: 'prices/v1',
      effectiveDate: '2026-10-06',
      currency: 'USD',
      unit: 'nano_usd_per_token',
      source: 'test',
      models: { m: { inputNanoUsdPerToken: 100, outputNanoUsdPerToken: 500 } },
    };
    expect(PriceTable.safeParse(base).success).toBe(true);
    expect(PriceTable.safeParse({ ...base, id: 'prices' }).success).toBe(false);
    expect(PriceTable.safeParse({ ...base, effectiveDate: 'yesterday' }).success).toBe(false);
    expect(
      PriceTable.safeParse({
        ...base,
        models: { m: { inputNanoUsdPerToken: 0.5, outputNanoUsdPerToken: 1 } },
      }).success,
    ).toBe(false);
    expect(
      PriceTable.safeParse({
        ...base,
        models: { m: { inputNanoUsdPerToken: -1, outputNanoUsdPerToken: 1 } },
      }).success,
    ).toBe(false);
  });
});

function firstOf(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const list = value[key] as Record<string, unknown>[];
  const first = list[0];
  if (!first) throw new Error(`fixture list ${key} is empty`);
  return first;
}
