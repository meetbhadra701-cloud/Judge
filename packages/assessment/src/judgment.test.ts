import { ScoreReport } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import type { UnitCandidates } from './candidates.js';
import {
  applyPostGates,
  buildAssessorJudgments,
  classifyDisposition,
  deterministicFlags,
  preGated,
  UNIT_DISPOSITION_VALUES,
  type FinalUnit,
  type ValidatedJudgment,
} from './judgment.js';
import { validateDimensionAssessment } from './stage.js';
import { build, scoreProject } from './testing/scoring.js';
import { lockedSnapshot, seeded } from './testing/world.js';

const SCALE = { min: 0, max: 10 };
const built = build();
const unitA = built.units[0] as UnitCandidates;
const unitB = built.units[1] as UnitCandidates;
const statementHandle = unitA.items.find((i) => i.authorship === 'team_statement')?.handle ?? '';
const factHandle = unitA.items.find((i) => i.authorship === 'interpreted_fact')?.handle ?? '';

function output(overrides: Record<string, unknown> = {}) {
  return {
    dimensionId: unitA.dimensionId,
    outcome: { kind: 'scored', score: 6.5 },
    citations: [
      {
        evidence: statementHandle,
        directness: 'direct',
        specificity: 'exact',
        note: 'the team says so',
      },
    ],
    rationale: 'The submission states a clear problem and the code validates input.',
    limitations: ['only_team_statements'],
    ...overrides,
  };
}
function validated(json: unknown, unit = unitA): ValidatedJudgment {
  const result = validateDimensionAssessment(json, unit, SCALE);
  if (!result.ok) throw new Error(`rejected: ${JSON.stringify(result)}`);
  return result.judgment;
}
const codes = (json: unknown, unit = unitA) => {
  const result = validateDimensionAssessment(json, unit, SCALE);
  return result.ok ? [] : result.phase === 'shape' ? ['shape'] : result.issues.map((i) => i.code);
};

describe('G6: dimension judgments', () => {
  it('accepts a judgment that cites only shown evidence, and resolves handles to persisted ids in code', () => {
    const judgment = validated(output());
    expect(judgment.citations[0]?.handle).toBe(statementHandle);
    expect(judgment.citations[0]?.evidenceId).toBe(unitA.byHandle.get(statementHandle)?.evidenceId);
    expect(judgment.limitations).toEqual(['only_team_statements']);
  });

  it('rejects the wrong dimension', () => {
    expect(codes(output({ dimensionId: unitB.dimensionId }))).toEqual(['wrong_dimension']);
  });

  it('rejects an unshown handle, a handle of another unit, and a persisted UUID used as a citation (shape)', () => {
    expect(
      codes(
        output({
          citations: [{ evidence: 'E-099', directness: 'direct', specificity: 'exact', note: 'x' }],
        }),
      ),
    ).toEqual(['unknown_citation_handle']);
    // a handle that exists only in another unit's closed set
    const narrow: UnitCandidates = {
      ...unitA,
      items: unitA.items.slice(0, 1),
      byHandle: new Map(unitA.items.slice(0, 1).map((i) => [i.handle, i])),
    };
    const other = unitA.items[1]?.handle ?? '';
    expect(
      codes(
        output({
          citations: [{ evidence: other, directness: 'direct', specificity: 'exact', note: 'x' }],
        }),
        narrow,
      ),
    ).toEqual(['unknown_citation_handle']);
    expect(
      codes(
        output({
          citations: [
            {
              evidence: unitA.items[0]?.evidenceId,
              directness: 'direct',
              specificity: 'exact',
              note: 'x',
            },
          ],
        }),
      ),
    ).toEqual(['shape']);
  });

  it('rejects cross-project and unrelated evidence: nothing outside the shown set can be cited', () => {
    const foreignId = '99999999-0000-4000-8000-000000000001';
    expect(
      codes(
        output({
          citations: [
            { evidence: foreignId, directness: 'direct', specificity: 'exact', note: 'x' },
          ],
        }),
      ),
    ).toEqual(['shape']);
    expect(
      codes(
        output({
          citations: [{ evidence: 'E-500', directness: 'direct', specificity: 'exact', note: 'x' }],
        }),
      ),
    ).toEqual(['unknown_citation_handle']);
  });

  it('rejects a duplicate citation, a scored judgment without citations, and an out-of-scale or non-finite score', () => {
    const cite = {
      evidence: statementHandle,
      directness: 'direct',
      specificity: 'exact',
      note: 'x',
    };
    expect(codes(output({ citations: [cite, cite] }))).toEqual(['duplicate_citation']);
    // missing evidence is not negative evidence: a low score cannot rest on nothing
    expect(codes(output({ outcome: { kind: 'scored', score: 1 }, citations: [] }))).toEqual([
      'scored_without_citation',
    ]);
    expect(codes(output({ outcome: { kind: 'scored', score: 11 } }))).toEqual([
      'score_out_of_scale',
    ]);
    expect(codes(output({ outcome: { kind: 'scored', score: -0.1 } }))).toEqual([
      'score_out_of_scale',
    ]);
    expect(codes(output({ outcome: { kind: 'scored', score: Number.NaN } }))).toEqual(['shape']);
    expect(codes(output({ outcome: { kind: 'scored', score: Number.POSITIVE_INFINITY } }))).toEqual(
      ['shape'],
    );
  });

  it("accepts the unit's own scale endpoints", () => {
    expect(validated(output({ outcome: { kind: 'scored', score: 0 } })).outcome).toEqual({
      kind: 'scored',
      score: 0,
    });
    expect(validated(output({ outcome: { kind: 'scored', score: 10 } })).outcome).toEqual({
      kind: 'scored',
      score: 10,
    });
  });

  it('refuses every field a model must never supply: totals, weights, confidence, strength, levels, ids (strict)', () => {
    for (const extra of [
      { overall: 7 },
      { criterionTotal: 6 },
      { weight: 0.5 },
      { confidence: 0.9 },
      { evidenceStrength: 1 },
      { verificationLevel: 'machine_verified' },
      { evidenceId: 'x' },
      { ranking: 1 },
    ]) {
      expect(codes(output(extra)), JSON.stringify(extra)).toEqual(['shape']);
    }
  });

  it('refuses a privileged trust level smuggled into a citation (attempted escalation)', () => {
    const escalate = {
      evidence: statementHandle,
      directness: 'direct',
      specificity: 'exact',
      note: 'x',
      verificationLevel: 'judge_verified',
    };
    expect(codes(output({ citations: [escalate] }))).toEqual(['shape']);
  });

  it('only lets Event-Context reference items be cited as indirect, generic context', () => {
    const locked = lockedSnapshot({
      trackKeys: ['health'],
      rules: [{ statement: 'Projects must be original work.', certainty: 'explicit' }],
    });
    const refs = build({ locked, declaredTrackKeys: ['health'] });
    const unit = refs.units[0] as UnitCandidates;
    const ref = unit.items.find((i) => i.authorship === 'event_reference')?.handle ?? '';
    const strong = output({
      dimensionId: unit.dimensionId,
      citations: [{ evidence: ref, directness: 'direct', specificity: 'exact', note: 'x' }],
    });
    expect(codes(strong, unit)).toEqual(['event_reference_classification']);
    const weak = output({
      dimensionId: unit.dimensionId,
      citations: [{ evidence: ref, directness: 'indirect', specificity: 'generic', note: 'x' }],
    });
    expect(codes(weak, unit)).toEqual([]);
  });

  it('reports every issue with a code and a path, never with text', () => {
    const result = validateDimensionAssessment(
      output({ dimensionId: 'x.y', outcome: { kind: 'scored', score: 99 }, citations: [] }),
      unitA,
      SCALE,
    );
    expect(
      !result.ok && result.phase === 'domain' && result.issues.map((i) => i.code).sort(),
    ).toEqual(['score_out_of_scale', 'scored_without_citation', 'wrong_dimension']);
    expect(JSON.stringify(result)).not.toContain('submission states');
  });
});

describe('post-gates change a scored judgment only into insufficient_evidence', () => {
  it('keeps an ordinary scored judgment as it is', () => {
    const final = applyPostGates(validated(output()), unitA);
    expect(final.disposition).toBe('scored');
    expect(final.judgment?.outcome).toEqual({ kind: 'scored', score: 6.5 });
  });

  it('records an assessor-reported insufficiency as a VALID outcome', () => {
    const final = applyPostGates(
      validated(output({ outcome: { kind: 'insufficient_evidence' }, citations: [] })),
      unitA,
    );
    expect(final.disposition).toBe('assessor_reported_insufficient');
    expect(classifyDisposition(final.disposition)).toBe('valid_insufficiency');
  });

  const locked = lockedSnapshot({
    trackKeys: ['health'],
    rules: [{ statement: 'Projects must be original work.', certainty: 'explicit' }],
  });
  const refs = build({ locked, declaredTrackKeys: ['health'] });
  const refUnit = refs.units[0] as UnitCandidates;
  const refHandle = refUnit.items.find((i) => i.authorship === 'event_reference')?.handle ?? '';
  const projectHandle = refUnit.items.find((i) => i.projectDerived)?.handle ?? '';

  it('event-reference-only eligibility claims cannot carry a score', () => {
    const weakRef = {
      evidence: refHandle,
      directness: 'indirect',
      specificity: 'generic',
      note: 'the rule applies',
    };
    const judgment = validated(
      output({ dimensionId: refUnit.dimensionId, citations: [weakRef] }),
      refUnit,
    );
    const final = applyPostGates(judgment, refUnit);
    expect(final.disposition).toBe('event_reference_only');
    expect(classifyDisposition(final.disposition)).toBe('valid_insufficiency');
  });

  it('an event rule plus a project citation may be assessed', () => {
    const judgment = validated(
      output({
        dimensionId: refUnit.dimensionId,
        citations: [
          { evidence: refHandle, directness: 'indirect', specificity: 'generic', note: 'the rule' },
          {
            evidence: projectHandle,
            directness: 'adjacent',
            specificity: 'partial',
            note: 'the team statement',
          },
        ],
      }),
      refUnit,
    );
    expect(applyPostGates(judgment, refUnit).disposition).toBe('scored');
  });

  it('a fallback Track unit needs a project-derived citation and a satisfied need (decision N4)', () => {
    const track: UnitCandidates = {
      ...refUnit,
      dimensionId: 'track_prize_alignment.track_fit',
      needGroups: [['event_context']],
    };
    const justRule = validated(
      output({
        dimensionId: track.dimensionId,
        citations: [
          { evidence: refHandle, directness: 'indirect', specificity: 'generic', note: 'rule' },
        ],
      }),
      track,
    );
    expect(applyPostGates(justRule, track).disposition).toBe('event_reference_only');
    const zeroCoverage: UnitCandidates = {
      ...refUnit,
      dimensionId: 'technical_execution.implementation_depth',
      needGroups: [['source_code']],
    };
    const statementOnly =
      refUnit.items.find((i) => i.authorship === 'team_statement')?.handle ?? '';
    const onlyStatement = validated(
      output({
        dimensionId: zeroCoverage.dimensionId,
        citations: [
          { evidence: statementOnly, directness: 'direct', specificity: 'exact', note: 'x' },
        ],
      }),
      zeroCoverage,
    );
    const final = applyPostGates(onlyStatement, zeroCoverage);
    expect(final.disposition).toBe('no_declared_need_satisfied');
    // code downgraded it; it never edited the score
    expect(final.judgment?.outcome).toEqual({ kind: 'scored', score: 6.5 });
  });
});

describe('deterministic flags for the critic', () => {
  const base = (patch: Partial<ValidatedJudgment> = {}): ValidatedJudgment => ({
    ...validated(output()),
    ...patch,
  });
  it('flags raw-signal reasoning, anchor-bracket violations, weak citations, uncited handles and team-only evidence', () => {
    const noisy = base({ rationale: 'It has 120 commits and many stars, see E-007.' });
    expect(deterministicFlags(noisy, unitA, [0, 10])).toEqual(
      expect.arrayContaining([
        'raw_signal_terms',
        'rationale_mentions_uncited_handle',
        'only_team_authored_evidence',
      ]),
    );
    const weak = base({
      citations: [
        {
          ...(validated(output()).citations[0] as NonNullable<
            ValidatedJudgment['citations'][number]
          >),
          directness: 'indirect',
          specificity: 'generic',
        },
      ],
    });
    expect(deterministicFlags(weak, unitA, [])).toContain('all_citations_weak');
    const outside = base({ outcome: { kind: 'scored', score: 9.5 } });
    expect(deterministicFlags(outside, unitA, [2, 8])).toContain('score_outside_anchor_bracket');
    expect(deterministicFlags(outside, unitA, [])).not.toContain('score_outside_anchor_bracket');
  });
  it('does not flag a clean judgment that mixes authorship', () => {
    const mixed = validated(
      output({
        citations: [
          { evidence: statementHandle, directness: 'direct', specificity: 'exact', note: 'claim' },
          { evidence: factHandle, directness: 'adjacent', specificity: 'partial', note: 'code' },
        ],
      }),
    );
    expect(deterministicFlags(mixed, unitA, [0, 10])).toEqual([]);
  });
});

describe('the exact input for the M4 scorer', () => {
  const finals = (): FinalUnit[] => [
    applyPostGates(validated(output()), unitA),
    applyPostGates(
      validated(
        output({
          dimensionId: unitB.dimensionId,
          outcome: { kind: 'insufficient_evidence' },
          citations: [],
        }),
        unitB,
      ),
      unitB,
    ),
  ];

  it('contains only dimension id, outcome and classified citations, sorted, with engine version', () => {
    const result = buildAssessorJudgments(finals(), built.context.rubric);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.engineVersion).toBe('scoring-engine/v1');
    expect(result.input.judgments.map((j) => j.dimensionId)).toEqual([
      'official.problem_fit',
      'official.usability',
    ]);
    const text = JSON.stringify(result.input);
    for (const stripped of ['rationale', 'note', 'limitations', 'handle', 'E-0'])
      expect(text).not.toContain(stripped);
    expect(Object.keys(result.input.judgments[0]?.citations[0] ?? {}).sort()).toEqual([
      'directness',
      'evidenceId',
      'specificity',
    ]);
  });

  it('is accepted by the real scorer and yields a schema-valid report', () => {
    const result = buildAssessorJudgments(finals(), built.context.rubric);
    if (!result.ok) throw new Error('input');
    const scored = scoreProject(built.context, result.input);
    expect(scored.ok).toBe(true);
    if (scored.ok) {
      expect(ScoreReport.safeParse(scored.report).success).toBe(true);
      expect(scored.report.notices.semanticRelevance).toBe('not_verified');
      expect(scored.report.dimensions.find((d) => d.id === 'official.problem_fit')?.state).toBe(
        'assessed',
      );
      expect(scored.report.dimensions.find((d) => d.id === 'official.usability')?.state).toBe(
        'insufficient_evidence',
      );
    }
  });

  it('makes every non-surviving disposition insufficient_evidence with no citations (technical, substantive and code downgrades)', () => {
    for (const disposition of UNIT_DISPOSITION_VALUES) {
      if (disposition === 'scored' || disposition === 'assessor_reported_insufficient') continue;
      const unit: FinalUnit = {
        dimensionId: unitA.dimensionId,
        disposition,
        judgment: validated(output()),
      };
      const second: FinalUnit = preGated(unitB, 'no_candidate_evidence');
      const result = buildAssessorJudgments([unit, second], built.context.rubric);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input.judgments[0]?.outcome).toEqual({ kind: 'insufficient_evidence' });
        expect(result.input.judgments[0]?.citations).toEqual([]);
      }
    }
  });

  it('requires exactly one unit per applicable dimension', () => {
    const [first] = finals();
    if (!first) throw new Error('fixture');
    expect(buildAssessorJudgments([first], built.context.rubric).ok).toBe(false);
    expect(
      buildAssessorJudgments([first, first, ...finals().slice(1)], built.context.rubric).ok,
    ).toBe(false);
    const stranger: FinalUnit = {
      dimensionId: 'official.nope',
      disposition: 'no_candidate_evidence',
      judgment: null,
    };
    const result = buildAssessorJudgments([...finals(), stranger], built.context.rubric);
    expect(!result.ok && result.issues.map((i) => i.code)).toEqual(['unit_not_in_rubric']);
  });

  it('is independent of the order of units and of citations (seeded permutations)', () => {
    const cited = validated(
      output({
        citations: [
          { evidence: statementHandle, directness: 'direct', specificity: 'exact', note: 'a' },
          { evidence: factHandle, directness: 'adjacent', specificity: 'partial', note: 'b' },
        ],
      }),
    );
    const make = (reverse: boolean): string => {
      const judgment = reverse ? { ...cited, citations: [...cited.citations].reverse() } : cited;
      const units = [
        applyPostGates(judgment, unitA),
        applyPostGates(
          validated(
            output({
              dimensionId: unitB.dimensionId,
              outcome: { kind: 'insufficient_evidence' },
              citations: [],
            }),
            unitB,
          ),
          unitB,
        ),
      ];
      const next = seeded(reverse ? 5 : 9);
      const ordered = [...units].sort(() => next() - 0.5);
      const result = buildAssessorJudgments(ordered, built.context.rubric);
      if (!result.ok) throw new Error('input');
      return JSON.stringify(result.input);
    };
    expect(make(true)).toBe(make(false));
  });

  it('the report never contains a stronger evidence label than the policy emitted (end to end)', () => {
    const result = buildAssessorJudgments(finals(), built.context.rubric);
    if (!result.ok) throw new Error('input');
    const scored = scoreProject(built.context, result.input);
    if (!scored.ok) throw new Error('score');
    const text = JSON.stringify(scored.report);
    for (const forbidden of [
      'repo_corroborated',
      'machine_verified',
      'judge_verified',
      'live_verified',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });
});
