import { describe, expect, it } from 'vitest';
import { createTrustedScoringContext } from '../context.js';
import {
  baseWorld,
  lockedSnapshot,
  makeContext,
  rubricDefinition,
  uid,
  EVENT_ID,
  OTHER_EVENT_ID,
} from '../testing/builders.js';
import { FALLBACK_RUBRIC_DEFINITION, FALLBACK_TRACK_CRITERION_KEY } from './fallback.js';
import { selectRubric } from './select.js';

const OFFICIAL_WEIGHTED = rubricDefinition({
  scaleMin: 1,
  scaleMax: 5,
  criteria: [
    { key: 'innovation', name: 'Innovation', weight: 0.6 },
    { key: 'execution', name: 'Execution', weight: 0.4 },
  ],
});
const UNWEIGHTED = rubricDefinition({
  criteria: [
    { key: 'innovation', weight: null },
    { key: 'execution', weight: null },
    { key: 'presentation', weight: null },
  ],
});

const select = (
  locked = lockedSnapshot(),
  target: Parameters<typeof selectRubric>[0]['target'] = { kind: 'overall' },
  declaredTrackKeys: string[] = [],
) => selectRubric({ locked, target, declaredTrackKeys });

describe('fallback-rubric/v1 data', () => {
  const dimensions = FALLBACK_RUBRIC_DEFINITION.flatMap((criterion) =>
    criterion.dimensions.map((dimension) => ({ criterion, dimension })),
  );

  it('has the seven published criteria and 36 dimensions', () => {
    expect(FALLBACK_RUBRIC_DEFINITION.map((c) => [c.key, c.weightPercent])).toEqual([
      ['technical_execution', 20],
      ['completion_functionality', 20],
      ['innovation_creativity', 15],
      ['impact_problem_fit', 15],
      ['design_user_experience', 10],
      ['demo_communication', 10],
      ['track_prize_alignment', 10],
    ]);
    expect(dimensions).toHaveLength(36);
    expect(FALLBACK_RUBRIC_DEFINITION.map((c) => c.dimensions.length)).toEqual([
      5, 5, 4, 6, 6, 5, 5,
    ]);
  });

  it('has weights that sum to 100 within every criterion and across the rubric', () => {
    expect(FALLBACK_RUBRIC_DEFINITION.reduce((sum, c) => sum + c.weightPercent, 0)).toBe(100);
    for (const criterion of FALLBACK_RUBRIC_DEFINITION) {
      expect(
        criterion.dimensions.reduce((sum, d) => sum + d.weightPercent, 0),
        criterion.key,
      ).toBe(100);
    }
  });

  it('has the published dimension weights', () => {
    const weights = Object.fromEntries(
      dimensions.map(({ criterion, dimension }) => [
        `${criterion.key}.${dimension.key}`,
        dimension.weightPercent,
      ]),
    );
    expect(weights['technical_execution.implementation_depth']).toBe(25);
    expect(weights['completion_functionality.core_user_flow']).toBe(30);
    expect(weights['innovation_creativity.novelty_of_approach']).toBe(30);
    expect(weights['impact_problem_fit.solution_problem_fit']).toBe(30);
    expect(weights['design_user_experience.primary_task_clarity']).toBe(25);
    expect(weights['demo_communication.actual_proof_demonstration']).toBe(30);
    expect(weights['track_prize_alignment.actual_implementation_evidence']).toBe(30);
  });

  it('has unique, well-formed IDs and non-empty evidence needs', () => {
    const ids = dimensions.map(({ criterion, dimension }) => `${criterion.key}.${dimension.key}`);
    expect(new Set(ids).size).toBe(36);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    for (const { dimension } of dimensions) {
      expect(dimension.needGroups.length).toBeGreaterThan(0);
      for (const group of dimension.needGroups) expect(group.length).toBeGreaterThan(0);
    }
  });

  it('documents the pre-M7 limitation: exactly two dimensions have a group only the interview can satisfy', () => {
    const interviewOnly = new Set(['team_answer', 'judge_observation']);
    const capped = dimensions
      .filter(({ dimension }) =>
        dimension.needGroups.some((group) => group.every((channel) => interviewOnly.has(channel))),
      )
      .map(({ dimension }) => dimension.key)
      .sort();
    expect(capped).toEqual(['qa_understanding', 'technical_ownership']);
    const qa = dimensions.find(({ dimension }) => dimension.key === 'qa_understanding');
    expect(qa?.dimension.needGroups).toEqual([['team_answer', 'judge_observation']]);
    const ownership = dimensions.find(({ dimension }) => dimension.key === 'technical_ownership');
    expect(ownership?.dimension.needGroups).toHaveLength(2);
  });
});

describe('rubric precedence (official wins, no mixing)', () => {
  it('uses the official overall rubric whole, retaining its published weights and scale', () => {
    const result = select(lockedSnapshot({ rubrics: [OFFICIAL_WEIGHTED] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { rubric } = result;
    expect(rubric.source).toBe('official_event_context');
    expect(rubric.rubricVersion).toBeNull();
    expect(rubric.weightBasis).toBe('official');
    expect(rubric.needsBasis).toBe('unspecified');
    expect(rubric.scale).toEqual({ min: 1, max: 5 });
    expect(rubric.criteria.map((c) => [c.key, c.weight])).toEqual([
      ['innovation', 0.6],
      ['execution', 0.4],
    ]);
    expect(rubric.criteria.every((c) => c.applicable)).toBe(true);
    // No fallback criterion leaks in.
    expect(rubric.criteria.flatMap((c) => c.dimensions.map((d) => d.id))).toEqual([
      'official.innovation',
      'official.execution',
    ]);
  });

  it('treats each official criterion as ONE atomic unit of weight 1 with no invented needs', () => {
    const result = select(lockedSnapshot({ rubrics: [OFFICIAL_WEIGHTED] }));
    if (!result.ok) throw new Error('expected ok');
    for (const criterion of result.rubric.criteria) {
      expect(criterion.dimensions).toHaveLength(1);
      expect(criterion.dimensions[0]?.weight).toBe(1);
      expect(criterion.dimensions[0]?.needGroups).toBeNull();
    }
  });

  it('keeps an unweighted official rubric unweighted (no weights are invented)', () => {
    const result = select(lockedSnapshot({ rubrics: [UNWEIGHTED] }));
    if (!result.ok) throw new Error('expected ok');
    expect(result.rubric.weightBasis).toBe('unweighted_official');
    expect(result.rubric.criteria.map((c) => c.weight)).toEqual([null, null, null]);
  });

  it('uses the fallback ONLY when the locked context has no official overall rubric', () => {
    const none = select(lockedSnapshot());
    expect(none.ok && none.rubric.source).toBe('universal_fallback');
    if (!none.ok) return;
    expect(none.rubric.rubricVersion).toBe('fallback-rubric/v1');
    expect(none.rubric.weightBasis).toBe('fallback');
    expect(none.rubric.needsBasis).toBe('declared');
    expect(none.rubric.scale).toEqual({ min: 0, max: 10 });
    expect(none.rubric.criteria).toHaveLength(7);
    expect(none.rubric.criteria.flatMap((c) => c.dimensions)).toHaveLength(36);
    // Bound to the exact locked version that was in force.
    expect(none.rubric.contextVersionId).not.toBeNull();
  });

  it('does not use the fallback when only a TRACK rubric exists: the overall target still falls back, separately', () => {
    const track = rubricDefinition({
      scope: 'track',
      trackKey: 'ai_track',
      criteria: [{ key: 'fit', weight: 1 }],
    });
    const locked = lockedSnapshot({ rubrics: [track], trackKeys: ['ai_track'] });
    const overall = select(locked, { kind: 'overall' }, ['ai_track']);
    expect(overall.ok && overall.rubric.source).toBe('universal_fallback');
    const trackResult = select(locked, { kind: 'track', trackKey: 'ai_track' }, ['ai_track']);
    expect(trackResult.ok && trackResult.rubric.source).toBe('official_event_context');
    expect(trackResult.ok && trackResult.rubric.scope).toBe('track');
  });

  it('never mixes: with an official rubric, no fallback criterion or dimension appears', () => {
    const result = select(lockedSnapshot({ rubrics: [OFFICIAL_WEIGHTED] }), { kind: 'overall' }, [
      'x',
    ]);
    if (!result.ok) throw new Error('expected ok');
    const keys = result.rubric.criteria.map((c) => c.key);
    expect(keys).not.toContain(FALLBACK_TRACK_CRITERION_KEY);
    expect(keys.some((key) => key.startsWith('technical'))).toBe(false);
  });
});

describe('invalid official rubrics are rejected, never repaired and never replaced by the fallback', () => {
  const invalid: [string, ReturnType<typeof rubricDefinition>][] = [
    [
      'weights that do not sum to 1',
      rubricDefinition({
        criteria: [
          { key: 'a', weight: 0.5 },
          { key: 'b', weight: 0.6 },
        ],
      }),
    ],
    [
      'partially weighted',
      rubricDefinition({
        criteria: [
          { key: 'a', weight: 0.5 },
          { key: 'b', weight: null },
        ],
      }),
    ],
    [
      'a zero weight',
      rubricDefinition({
        criteria: [
          { key: 'a', weight: 0 },
          { key: 'b', weight: 1 },
        ],
      }),
    ],
    [
      'a negative weight',
      rubricDefinition({
        criteria: [
          { key: 'a', weight: -0.5 },
          { key: 'b', weight: 1.5 },
        ],
      }),
    ],
    ['a weight above one', rubricDefinition({ criteria: [{ key: 'a', weight: 1.5 }] })],
    [
      'a NaN weight',
      rubricDefinition({
        criteria: [
          { key: 'a', weight: Number.NaN },
          { key: 'b', weight: 1 },
        ],
      }),
    ],
    [
      'an infinite weight',
      rubricDefinition({ criteria: [{ key: 'a', weight: Number.POSITIVE_INFINITY }] }),
    ],
    [
      'duplicate criterion keys',
      rubricDefinition({
        criteria: [
          { key: 'a', weight: 0.5 },
          { key: 'a', weight: 0.5 },
        ],
      }),
    ],
    ['no criteria', rubricDefinition({ criteria: [] })],
    [
      'an empty scale',
      rubricDefinition({ scaleMin: 5, scaleMax: 5, criteria: [{ key: 'a', weight: 1 }] }),
    ],
    [
      'an inverted scale',
      rubricDefinition({ scaleMin: 10, scaleMax: 0, criteria: [{ key: 'a', weight: 1 }] }),
    ],
    [
      'a non-finite scale',
      rubricDefinition({
        scaleMin: 0,
        scaleMax: Number.POSITIVE_INFINITY,
        criteria: [{ key: 'a', weight: 1 }],
      }),
    ],
  ];

  it.each(invalid)('rejects %s as RUBRIC_INVALID', (_name, rubric) => {
    const result = select(lockedSnapshot({ rubrics: [rubric] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.every((issue) => issue.code === 'RUBRIC_INVALID')).toBe(true);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('rejects a duplicated overall rubric as ambiguous', () => {
    const result = select(lockedSnapshot({ rubrics: [OFFICIAL_WEIGHTED, OFFICIAL_WEIGHTED] }));
    expect(result.ok).toBe(false);
  });

  it('flows through the trusted context: no scoring context exists for an invalid official rubric', () => {
    const graph = baseWorld().build();
    const result = createTrustedScoringContext({
      ...graph,
      locked: lockedSnapshot({ rubrics: [invalid[0]?.[1] ?? OFFICIAL_WEIGHTED] }),
      target: { kind: 'overall' },
      declaredTrackKeys: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain('RUBRIC_INVALID');
  });

  it('accepts a valid rubric whose published weights are within tolerance and retains them exactly', () => {
    const rubric = rubricDefinition({
      criteria: [
        { key: 'a', weight: 0.3333333 },
        { key: 'b', weight: 0.3333333 },
        { key: 'c', weight: 0.3333334 },
      ],
    });
    const result = select(lockedSnapshot({ rubrics: [rubric] }));
    if (!result.ok) throw new Error('expected ok');
    expect(result.rubric.criteria.map((c) => c.weight)).toEqual([0.3333333, 0.3333333, 0.3333334]);
  });
});

describe('locked context binding', () => {
  it('rejects a snapshot that no longer hashes to its recorded content hash', () => {
    const result = select(lockedSnapshot({ rubrics: [OFFICIAL_WEIGHTED], tamper: true }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe('LOCKED_CONTEXT_MISMATCH');
  });

  it('detects an edited rubric weight under an unchanged recorded hash', () => {
    const locked = lockedSnapshot({ rubrics: [OFFICIAL_WEIGHTED] });
    const edited = {
      ...locked,
      document: {
        ...locked.document,
        rubrics: locked.document.rubrics.map((r) => ({
          ...r,
          criteria: r.criteria.map((c, i) => (i === 0 ? { ...c, weight: 0.9 } : c)),
        })),
      },
    };
    const result = select(edited);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe('LOCKED_CONTEXT_MISMATCH');
  });

  it('refuses a context locked for another event', () => {
    const graph = baseWorld().build();
    const result = createTrustedScoringContext({
      ...graph,
      locked: lockedSnapshot({ eventId: OTHER_EVENT_ID }),
      target: { kind: 'overall' },
      declaredTrackKeys: [],
    });
    expect(graph.eventId).toBe(EVENT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain('LOCKED_CONTEXT_MISMATCH');
  });
});

describe('track targets and declared tracks', () => {
  const trackRubric = rubricDefinition({
    scope: 'track',
    trackKey: 'ai_track',
    name: 'AI track',
    criteria: [{ key: 'fit', weight: 1 }],
  });
  const locked = lockedSnapshot({
    rubrics: [OFFICIAL_WEIGHTED, trackRubric],
    trackKeys: ['ai_track'],
  });

  it('scores a declared track against its own official rubric, never blended with the overall', () => {
    const result = select(locked, { kind: 'track', trackKey: 'ai_track' }, ['ai_track']);
    if (!result.ok) throw new Error('expected ok');
    expect(result.rubric.scope).toBe('track');
    expect(result.rubric.trackKey).toBe('ai_track');
    expect(result.rubric.criteria.map((c) => c.key)).toEqual(['fit']);
  });

  it('refuses a track the project did not declare', () => {
    const result = select(locked, { kind: 'track', trackKey: 'ai_track' }, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe('TARGET_TRACK_NOT_DECLARED');
  });

  it('refuses a declared track that has no official rubric, with no fallback', () => {
    const result = select(locked, { kind: 'track', trackKey: 'other' }, ['other']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe('RUBRIC_NOT_FOUND');
  });

  it('normalizes declared track keys (unique, sorted) and rejects malformed ones', () => {
    const fine = select(lockedSnapshot(), { kind: 'overall' }, ['b_track', 'a_track', 'b_track']);
    expect(fine.ok && fine.declaredTrackKeys).toEqual(['a_track', 'b_track']);
    const bad = select(lockedSnapshot(), { kind: 'overall' }, ['Not A Key', '']);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.every((i) => i.code === 'INVALID_INPUT')).toBe(true);
  });

  it('marks the FALLBACK Track criterion not_applicable only when no track is declared', () => {
    const without = select(lockedSnapshot(), { kind: 'overall' }, []);
    const withTrack = select(lockedSnapshot(), { kind: 'overall' }, ['ai_track']);
    if (!without.ok || !withTrack.ok) throw new Error('expected ok');
    const applicable = (rubric: typeof without.rubric) =>
      rubric.criteria.find((c) => c.key === FALLBACK_TRACK_CRITERION_KEY)?.applicable;
    expect(applicable(without.rubric)).toBe(false);
    expect(applicable(withTrack.rubric)).toBe(true);
    expect(without.rubric.criteria.filter((c) => !c.applicable).map((c) => c.key)).toEqual([
      FALLBACK_TRACK_CRITERION_KEY,
    ]);
  });

  it('NEVER removes an official criterion because no track was declared (even one named like a track)', () => {
    const rubric = rubricDefinition({
      criteria: [
        { key: 'track_prize_alignment', weight: 0.5 },
        { key: 'execution', weight: 0.5 },
      ],
    });
    for (const declared of [[], ['ai_track']]) {
      const result = select(lockedSnapshot({ rubrics: [rubric] }), { kind: 'overall' }, declared);
      if (!result.ok) throw new Error('expected ok');
      expect(result.rubric.criteria.every((c) => c.applicable)).toBe(true);
    }
  });
});

describe('the trusted context', () => {
  it('can be built for the standard fixture world', () => {
    expect(() => makeContext(baseWorld().build(), lockedSnapshot())).not.toThrow();
    expect(uid(1)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
