import { describe, expect, it } from 'vitest';
import type { JudgmentInput } from './assessment-store.js';
import { checkJudgmentCalls, isValidResponse, type LedgerCallView } from './judgment-calls.js';
import { scorerInputOf, validateJudgmentRecords } from './trusted-rescoring.js';

/* Pure units of the recomputation boundary and of the call binding (no database). */

const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';

const judgment = (patch: Partial<JudgmentInput> = {}): JudgmentInput => ({
  dimensionId: 'official.problem_fit',
  outcomeKind: 'scored',
  score: 7,
  disposition: 'scored',
  rationale: 'Supported by the cited record.',
  limitations: [],
  assessorAttempts: 1,
  criticAttempts: 0,
  assessorCallSeqs: [1],
  criticCallSeqs: [],
  criticReviewRequired: false,
  criticReviewed: false,
  citations: [{ evidenceId: E1, directness: 'direct', specificity: 'exact', note: null }],
  ...patch,
});
const insufficient = (patch: Partial<JudgmentInput> = {}): JudgmentInput =>
  judgment({
    outcomeKind: 'insufficient_evidence',
    score: null,
    disposition: 'assessor_reported_insufficient',
    ...patch,
  });
const codes = (judgments: JudgmentInput[]) =>
  validateJudgmentRecords(judgments).map((issue) => issue.code);

describe('validateJudgmentRecords (M5-only vocabulary and consistency)', () => {
  it('accepts consistent records', () => {
    expect(codes([judgment(), insufficient({ dimensionId: 'official.usability' })])).toEqual([]);
  });

  it.each([
    ['a duplicate dimension', [judgment(), judgment()], 'duplicate_dimension'],
    [
      'an unknown disposition',
      [judgment({ disposition: 'invented' as never })],
      'unknown_disposition',
    ],
    [
      'a scored outcome with a non-scored disposition',
      [judgment({ disposition: 'assessor_reported_insufficient' })],
      'outcome_disposition_mismatch',
    ],
    [
      'a scored disposition with an insufficient outcome',
      [insufficient({ disposition: 'scored' })],
      'outcome_disposition_mismatch',
    ],
    [
      'a score on an insufficient judgment',
      [insufficient({ score: 4 })],
      'outcome_disposition_mismatch',
    ],
    ['a non-finite score', [judgment({ score: Number.POSITIVE_INFINITY })], 'score_not_finite'],
    [
      'citations kept by a gate-downgraded unit (the scorer received none)',
      [insufficient({ disposition: 'event_reference_only' })],
      'citations_not_allowed',
    ],
    [
      'a citation listed twice',
      [judgment({ citations: [...judgment().citations, ...judgment().citations] })],
      'duplicate_citation',
    ],
    [
      'an unknown classification',
      [
        judgment({
          citations: [{ evidenceId: E1, directness: 'sideways', specificity: 'exact', note: null }],
        }),
      ],
      'unknown_classification',
    ],
    ['an over-long rationale', [judgment({ rationale: 'x'.repeat(1_201) })], 'text_too_long'],
    [
      'an unknown limitation code',
      [judgment({ limitations: ['free text'] })],
      'unknown_limitation',
    ],
    [
      'an attempt count that is not the number of calls',
      [judgment({ assessorAttempts: 2 })],
      'attempts_inconsistent',
    ],
  ])('flags %s', (_label, judgments, code) => {
    expect(codes(judgments)).toContain(code);
  });
});

describe('scorerInputOf (the exact AssessorJudgmentsInput the records stand for)', () => {
  it('orders dimensions and citations canonically and keeps only id, outcome and classified citations', () => {
    const result = scorerInputOf([
      judgment({
        dimensionId: 'official.usability',
        citations: [
          { evidenceId: E2, directness: 'adjacent', specificity: 'partial', note: 'display only' },
          { evidenceId: E1, directness: 'direct', specificity: 'exact', note: null },
        ],
      }),
      insufficient({ dimensionId: 'official.problem_fit', citations: [] }),
    ]);
    expect(result).toEqual({
      ok: true,
      input: {
        engineVersion: 'scoring-engine/v1',
        judgments: [
          {
            dimensionId: 'official.problem_fit',
            outcome: { kind: 'insufficient_evidence' },
            citations: [],
          },
          {
            dimensionId: 'official.usability',
            outcome: { kind: 'scored', score: 7 },
            citations: [
              { evidenceId: E1, directness: 'direct', specificity: 'exact' },
              { evidenceId: E2, directness: 'adjacent', specificity: 'partial' },
            ],
          },
        ],
      },
    });
  });

  it('refuses what M4 refuses (never echoing the offending value)', () => {
    const bad = scorerInputOf([
      judgment({
        citations: [
          { evidenceId: 'not-a-uuid', directness: 'direct', specificity: 'exact', note: null },
        ],
      }),
    ]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(JSON.stringify(bad.issues)).not.toContain('not-a-uuid');
  });
});

describe('checkJudgmentCalls (R4 F7)', () => {
  const call = (patch: Partial<LedgerCallView> = {}): LedgerCallView => ({
    seq: 1,
    stage: 'dimension_assessment',
    dimensionId: 'official.problem_fit',
    state: 'settled',
    responseRecord: 'stored',
    outcomeCode: 'ok',
    boundViolation: false,
    providerMode: null,
    ...patch,
  });
  const codesOf = (judgments: JudgmentInput[], calls: LedgerCallView[], mode = 'scripted') =>
    checkJudgmentCalls(judgments, calls, mode).map((issue) => issue.code);

  it('accepts a valid binding', () => {
    expect(codesOf([judgment()], [call()])).toEqual([]);
  });

  it.each([
    ['an unknown call', [], 'call_not_found'],
    ['a call of another stage', [call({ stage: 'critic' })], 'call_wrong_stage'],
    [
      'a call of another dimension',
      [call({ dimensionId: 'official.usability' })],
      'call_wrong_dimension',
    ],
    ['a call without a dimension', [call({ dimensionId: null })], 'call_wrong_dimension'],
    ['a call still reserved', [call({ state: 'reserved' })], 'call_not_finished'],
    ['an assessor call that is unknown', [call({ state: 'unknown' })], 'assessor_response_missing'],
    [
      'a response that was not stored',
      [call({ responseRecord: 'too_large' })],
      'assessor_response_missing',
    ],
    ['an error outcome', [call({ outcomeCode: 'schema_invalid' })], 'assessor_response_missing'],
    ['a reservation overrun', [call({ boundViolation: true })], 'assessor_response_missing'],
    ['another provider mode', [call({ providerMode: 'live' })], 'provider_mode_mismatch'],
  ])('flags %s', (_label, calls, code) => {
    expect(codesOf([judgment()], calls)).toContain(code);
  });

  it('a call cannot be cited by two judgments', () => {
    const second = judgment({ dimensionId: 'official.usability' });
    expect(codesOf([judgment(), second], [call()])).toContain('call_cited_twice');
  });

  it('only a settled, stored, successful, in-bounds response is valid', () => {
    expect(isValidResponse(call())).toBe(true);
    for (const patch of [
      { state: 'unknown' },
      { state: 'released' },
      { responseRecord: 'none' },
      { outcomeCode: 'timeout' },
      { boundViolation: true },
    ] as Partial<LedgerCallView>[]) {
      expect(isValidResponse(call(patch))).toBe(false);
    }
  });
});
