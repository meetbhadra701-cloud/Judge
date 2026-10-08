import type { ScoreReport } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import { createTrustedScoringContext } from './context.js';
import { scoreProject } from './engine.js';
import type { FixtureGraph } from './testing/builders.js';
import {
  baseWorld,
  cite,
  codeEvidence,
  criterionScored,
  deploymentEvidence,
  devpostEvidence,
  fallbackPayload,
  IDS,
  insufficient,
  lockedSnapshot,
  makeContext,
  payload,
  rubricDefinition,
  scored,
  uid,
} from './testing/builders.js';

/*
 * The worked examples of docs/milestones/M4-design.md §6 (E1-E14), recomputed against the engine,
 * plus the output-safety guarantees. Expectations are written as literals, independent of the
 * implementation's tables.
 */

let counter = 0;
const eid = () => uid((counter += 1), 'e6000001');

function run(
  ctx: ReturnType<typeof makeContext>,
  body: ReturnType<typeof payload>,
  options?: unknown,
): ScoreReport {
  const result = scoreProject(ctx, body, options);
  if (!result.ok) throw new Error(`rejected: ${JSON.stringify(result.issues)}`);
  return result.report;
}

const dimension = (report: ScoreReport, id: string) => {
  const found = report.dimensions.find((entry) => entry.id === id);
  if (!found) throw new Error(`no dimension ${id}`);
  return found;
};
const criterion = (report: ScoreReport, key: string) => {
  const found = report.criteria.find((entry) => entry.key === key);
  if (!found) throw new Error(`no criterion ${key}`);
  return found;
};
/** A criterion that carries aggregates (not `not_applicable`). */
const aggregated = (report: ScoreReport, key: string) => {
  const found = criterion(report, key);
  if (found.state === 'not_applicable') throw new Error(`${key} is not applicable`);
  return found;
};
const assessed = (report: ScoreReport, id: string) => {
  const d = dimension(report, id);
  if (d.state !== 'assessed') throw new Error(`${id} is not assessed`);
  return d;
};

const FLOW = 'completion_functionality.core_user_flow';

/** The evidence of E1: code (0.60), deployment (0.15), Devpost sentence (0.126). */
function flowWorld(
  extra?: (g: FixtureGraph, ids: { code: string; dep: string; dev: string }) => void,
) {
  const g = baseWorld();
  const ids = {
    code: codeEvidence(g, eid()),
    dep: deploymentEvidence(g, eid()),
    dev: devpostEvidence(g, eid()),
  };
  extra?.(g, ids);
  return { g, ids, ctx: makeContext(g.build(), lockedSnapshot()) };
}
const flowCitations = (ids: { code: string; dep: string; dev: string }) => [
  cite(ids.code),
  cite(ids.dep),
  cite(ids.dev, 'adjacent', 'partial'),
];

describe('E1 / E5: one dimension, evidence strength is the maximum', () => {
  it('E1: strengths 0.60 / 0.15 / 0.126 -> evidenceStrength 0.60, coverage 2/2, confidence 0.6000', () => {
    const { ctx, ids } = flowWorld();
    const report = run(ctx, fallbackPayload([scored(FLOW, 7, ...flowCitations(ids))]));
    const d = assessed(report, FLOW);
    expect(d.evidenceStrength).toBe(0.6);
    expect(d.needs).toEqual({ kind: 'declared', totalGroups: 2, satisfiedGroups: 2, coverage: 1 });
    expect(d.confidenceBasis).toBe('declared_needs_coverage');
    expect(d.confidence).toBe(0.6);
    expect(d.score10).toBe(7);
    expect(d.scoreOnScale).toBe(7);
    expect(d.strongestEvidenceIds).toEqual([ids.code]);
    expect(d.provenanceGroupCount).toBe(3);
    expect(d.contradictionIds).toEqual([]);
  });

  it('E5: weak but well supported: score 3.0 with the same evidence -> confidence 0.6000', () => {
    const { ctx, ids } = flowWorld();
    const d = assessed(run(ctx, fallbackPayload([scored(FLOW, 3, ...flowCitations(ids))])), FLOW);
    expect(d.score10).toBe(3);
    expect(d.confidence).toBe(0.6);
  });

  it('the quality score is independent of how strong the evidence is', () => {
    const { ctx, ids } = flowWorld();
    const strong = assessed(run(ctx, fallbackPayload([scored(FLOW, 7, cite(ids.code))])), FLOW);
    const weak = assessed(
      run(ctx, fallbackPayload([scored(FLOW, 7, cite(ids.dev, 'indirect', 'generic'))])),
      FLOW,
    );
    expect(strong.score10).toBe(7);
    expect(weak.score10).toBe(7);
    expect(strong.confidence).toBeGreaterThan(weak.confidence);
  });
});

describe('E2: contradictions are uncertainty, never a deduction', () => {
  const expected = [0.6, 0.42, 0.294, 0.2058, 0.2058];
  it.each([0, 1, 2, 3, 4])(
    'k = %i recorded contradictions -> confidence %j, score unchanged',
    (k) => {
      const { ctx, ids } = flowWorld((g, { code }) => {
        for (let i = 0; i < k; i += 1) {
          const other = eid();
          devpostEvidence(g, other);
          g.contradict(
            uid(i + 1, 'd6000001'),
            { type: 'evidence', id: code },
            { type: 'evidence', id: other },
          );
        }
      });
      const report = run(ctx, fallbackPayload([scored(FLOW, 7, ...flowCitations(ids))]));
      const d = assessed(report, FLOW);
      expect(d.contradictionIds).toHaveLength(k);
      expect(d.confidence).toBe(expected[k]);
      expect(d.score10).toBe(7);
      expect(d.evidenceStrength).toBe(0.6);
    },
  );

  it('counts a contradiction once, however many cited items it touches', () => {
    const { ctx, ids } = flowWorld((g, { code, dep }) => {
      g.contradict(
        uid(1, 'd6000002'),
        { type: 'evidence', id: code },
        { type: 'evidence', id: dep },
      );
    });
    const d = assessed(run(ctx, fallbackPayload([scored(FLOW, 7, ...flowCitations(ids))])), FLOW);
    expect(d.contradictionIds).toEqual([uid(1, 'd6000002')]);
    expect(d.confidence).toBe(0.42);
  });

  it('maps contradictions through a related claim', () => {
    const { ctx, ids } = flowWorld((g, { code }) => {
      const claim = uid(1, 'c6000003');
      const other = eid();
      devpostEvidence(g, other);
      g.addClaim({ id: claim, label: 'team_claim' }).relate(claim, code);
      g.contradict(
        uid(1, 'd6000003'),
        { type: 'claim', id: claim },
        { type: 'evidence', id: other },
      );
    });
    const d = assessed(run(ctx, fallbackPayload([scored(FLOW, 7, ...flowCitations(ids))])), FLOW);
    expect(d.contradictionIds).toEqual([uid(1, 'd6000003')]);
    expect(d.confidence).toBe(0.42);
  });
});

describe('E3: ten statements are not ten sources', () => {
  const PROBLEM = 'impact_problem_fit.problem_clarity';

  it('ten team claims from one Devpost snapshot: strength 0.35 (noisy-OR would have said 0.9865)', () => {
    const g = baseWorld();
    const ids = Array.from({ length: 10 }, () => devpostEvidence(g, eid()));
    const ctx = makeContext(g.build(), lockedSnapshot());
    const d = assessed(
      run(ctx, fallbackPayload([scored(PROBLEM, 8, ...ids.map((id) => cite(id)))])),
      PROBLEM,
    );
    expect(d.evidenceStrength).toBe(0.35);
    expect(d.provenanceGroupCount).toBe(1);
    expect(d.confidence).toBe(0.35);
    expect(1 - 0.65 ** 10).toBeGreaterThan(0.98);
  });

  it('ten team claims from ten different snapshots: still 0.35 (max, not accumulation)', () => {
    const g = baseWorld();
    const ids = Array.from({ length: 10 }, (_, index) => {
      const snapshot = uid(index + 1, 'f7000001');
      g.snapshot(snapshot, 'devpost');
      const id = eid();
      g.addEvidence({
        id,
        origin: 'devpost',
        kind: 'claim',
        label: 'team_claim',
        snapshotId: snapshot,
      });
      return id;
    });
    const ctx = makeContext(g.build(), lockedSnapshot());
    const d = assessed(
      run(ctx, fallbackPayload([scored(PROBLEM, 8, ...ids.map((id) => cite(id)))])),
      PROBLEM,
    );
    expect(d.evidenceStrength).toBe(0.35);
    expect(d.provenanceGroupCount).toBe(10);
    expect(d.confidence).toBe(0.35);
  });

  it('ten adjacent/partial team claims: 0.126 (noisy-OR would have said 0.7399)', () => {
    const g = baseWorld();
    const ids = Array.from({ length: 10 }, () => devpostEvidence(g, eid()));
    const ctx = makeContext(g.build(), lockedSnapshot());
    const d = assessed(
      run(
        ctx,
        fallbackPayload([scored(PROBLEM, 8, ...ids.map((id) => cite(id, 'adjacent', 'partial')))]),
      ),
      PROBLEM,
    );
    expect(d.evidenceStrength).toBe(0.126);
  });
});

describe('E4 / E6 / E7: confidence, coverage and strength are separate', () => {
  it('E4: high quality, low confidence: score 9.0 from one Devpost sentence -> confidence 0.0630', () => {
    const g = baseWorld();
    const dev = devpostEvidence(g, eid());
    const ctx = makeContext(g.build(), lockedSnapshot());
    const id = 'technical_execution.architecture_integration';
    const report = run(ctx, fallbackPayload([scored(id, 9, cite(dev, 'adjacent', 'partial'))]));
    const d = assessed(report, id);
    expect(d.score10).toBe(9);
    expect(d.evidenceStrength).toBe(0.126);
    expect(d.needs).toEqual({
      kind: 'declared',
      totalGroups: 2,
      satisfiedGroups: 1,
      coverage: 0.5,
    });
    expect(d.confidence).toBe(0.063);
  });

  it('E6: evidence of the wrong kind gives coverage 0 and confidence 0, yet the score is still reported', () => {
    const id = 'track_prize_alignment.actual_implementation_evidence';
    const g = baseWorld();
    const dev = devpostEvidence(g, eid());
    const code = codeEvidence(g, eid());
    const locked = lockedSnapshot({ trackKeys: ['ai_track'] });
    const ctx = makeContext(g.build(), locked, { declaredTrackKeys: ['ai_track'] });
    const wrong = run(ctx, fallbackPayload([scored(id, 6, cite(dev))], { withTrack: true }));
    const d1 = assessed(wrong, id);
    expect(d1.evidenceStrength).toBe(0.35);
    expect(d1.needs).toMatchObject({ satisfiedGroups: 0, totalGroups: 1, coverage: 0 });
    expect(d1.confidence).toBe(0);
    expect(d1.score10).toBe(6);
    const right = run(
      ctx,
      fallbackPayload([scored(id, 6, cite(dev), cite(code))], { withTrack: true }),
    );
    const d2 = assessed(right, id);
    expect(d2.evidenceStrength).toBe(0.6);
    expect(d2.needs).toMatchObject({ satisfiedGroups: 1, coverage: 1 });
    expect(d2.confidence).toBe(0.6);
    expect(d2.score10).toBe(6);
  });

  it('E7: more of the same changes nothing: a second source-code item leaves confidence at 0.6000', () => {
    const { g, ids } = flowWorld();
    const code2 = codeEvidence(g, eid(), { artifactId: IDS.code2 });
    const ctx = makeContext(g.build(), lockedSnapshot());
    const d = assessed(
      run(ctx, fallbackPayload([scored(FLOW, 7, ...flowCitations(ids), cite(code2))])),
      FLOW,
    );
    expect(d.evidenceStrength).toBe(0.6);
    expect(d.confidence).toBe(0.6);
    expect(d.provenanceGroupCount).toBe(4);
  });
});

describe('E8: official criteria use the labeled citation-presence proxy, never coverage', () => {
  const rubric = rubricDefinition({
    criteria: [
      { key: 'innovation', weight: 0.5 },
      { key: 'execution', weight: 0.5 },
    ],
  });
  const cases: [
    string,
    'team_claim' | 'repo_corroborated',
    'direct' | 'adjacent',
    'exact' | 'partial',
    number,
  ][] = [
    ['one team claim, direct/exact', 'team_claim', 'direct', 'exact', 0.35],
    [
      'one repo_corroborated source item, direct/exact',
      'repo_corroborated',
      'direct',
      'exact',
      0.6,
    ],
    ['one team claim, adjacent/partial', 'team_claim', 'adjacent', 'partial', 0.126],
  ];
  it.each(cases)('%s -> confidence %j', (_name, level, directness, specificity, expected) => {
    const g = baseWorld();
    const id = eid();
    if (level === 'repo_corroborated') codeEvidence(g, id);
    else devpostEvidence(g, id);
    const ctx = makeContext(g.build(), lockedSnapshot({ rubrics: [rubric] }));
    const report = run(
      ctx,
      payload(
        scored('official.innovation', 7, cite(id, directness, specificity)),
        insufficient('official.execution'),
      ),
    );
    const d = assessed(report, 'official.innovation');
    expect(d.needs).toEqual({ kind: 'unspecified', citationPresence: 1 });
    expect(d.confidenceBasis).toBe('citation_presence');
    expect(d.confidence).toBe(expected);
    const c = criterion(report, 'innovation');
    expect('coverage' in c && c.coverage).toBeNull();
    expect('citationPresenceShare' in c && c.citationPresenceShare).toBe(1);
    expect(report.rubric.needsBasis).toBe('unspecified');
  });

  it('the fallback reports real coverage and no presence share', () => {
    const { ctx, ids } = flowWorld();
    const report = run(ctx, fallbackPayload([scored(FLOW, 7, ...flowCitations(ids))]));
    const c = criterion(report, 'completion_functionality');
    expect('coverage' in c && typeof c.coverage).toBe('number');
    expect('citationPresenceShare' in c && c.citationPresenceShare).toBeNull();
    expect(report.rubric.needsBasis).toBe('declared');
  });
});

describe('E9: privileged labels earn nothing', () => {
  const build = (
    label: 'repo_corroborated' | 'machine_verified' | 'judge_verified' | 'live_verified',
    artifact = IDS.code,
  ) => {
    const g = baseWorld();
    const id = eid();
    g.addEvidence({
      id,
      origin: 'github',
      kind: 'fact',
      label,
      snapshotId: IDS.github,
      artifactId: artifact,
      span: [0, 6],
    });
    const ctx = makeContext(g.build(), lockedSnapshot());
    return { id, ctx };
  };
  const dim = 'technical_execution.implementation_depth';

  it('honest repo_corroborated source code -> 0.60', () => {
    const { id, ctx } = build('repo_corroborated');
    const report = run(ctx, fallbackPayload([scored(dim, 5, cite(id))]));
    expect(assessed(report, dim).evidenceStrength).toBe(0.6);
    expect(report.diagnostics.map((d) => d.code)).not.toContain('UNATTESTED_PRIVILEGED_LEVEL');
  });

  it('the same row labeled machine_verified by direct SQL -> 0.15 plus a neutral diagnostic', () => {
    const { id, ctx } = build('machine_verified');
    const report = run(ctx, fallbackPayload([scored(dim, 5, cite(id))]));
    const d = assessed(report, dim);
    expect(d.evidenceStrength).toBe(0.15);
    expect(d.score10).toBe(5);
    const diagnostic = report.diagnostics.find(
      (entry) => entry.code === 'UNATTESTED_PRIVILEGED_LEVEL',
    );
    expect(diagnostic?.entityIds).toEqual([id]);
    expect(diagnostic?.message).not.toMatch(/cheat|fraud|fake|lie|accus/i);
  });

  it('a deployment fact labeled machine_verified is likewise worth 0.15', () => {
    const g = baseWorld();
    const id = deploymentEvidence(g, eid(), 'machine_verified');
    const ctx = makeContext(g.build(), lockedSnapshot());
    const runtime = 'completion_functionality.runtime_live_demonstration';
    const report = run(ctx, fallbackPayload([scored(runtime, 5, cite(id))]));
    expect(assessed(report, runtime).evidenceStrength).toBe(0.15);
    expect(report.diagnostics.some((d) => d.code === 'UNATTESTED_PRIVILEGED_LEVEL')).toBe(true);
  });

  it.each(['judge_verified', 'live_verified'] as const)(
    'GitHub evidence labeled %s cannot exist (the M3 matrix and CHECK forbid it): such a graph is rejected structurally, not scored',
    (label) => {
      const g = baseWorld();
      g.addEvidence({
        id: eid(),
        origin: 'github',
        kind: 'fact',
        label,
        snapshotId: IDS.github,
        artifactId: IDS.code,
        span: [0, 6],
      });
      const result = createTrustedScoringContext({
        ...g.build(),
        locked: lockedSnapshot(),
        target: { kind: 'overall' },
        declaredTrackKeys: [],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues[0]?.code).toBe('GRAPH_INTEGRITY_FAILED');
    },
  );

  it('repo_corroborated anchored to a README -> 0.15 plus UNSUPPORTED_REPO_CORROBORATION', () => {
    const { id, ctx } = build('repo_corroborated', IDS.readme);
    const report = run(ctx, fallbackPayload([scored(dim, 5, cite(id))]));
    expect(assessed(report, dim).evidenceStrength).toBe(0.15);
    expect(
      report.diagnostics.find((d) => d.code === 'UNSUPPORTED_REPO_CORROBORATION')?.entityIds,
    ).toEqual([id]);
  });

  it('a privileged label on a CLAIM never matters and is only reported', () => {
    const { ctx, ids } = flowWorld((g, { code }) => {
      const claim = uid(1, 'c6000009');
      g.addClaim({ id: claim, label: 'live_verified' }).relate(claim, code);
    });
    const report = run(ctx, fallbackPayload([scored(FLOW, 7, ...flowCitations(ids))]));
    expect(assessed(report, FLOW).confidence).toBe(0.6);
    expect(
      report.diagnostics.some(
        (d) => d.code === 'UNATTESTED_PRIVILEGED_LEVEL' && d.path === 'graph.claims',
      ),
    ).toBe(true);
  });
});

describe('D10: a scored judgment with nothing usable behind it is insufficient evidence', () => {
  const DIM = 'technical_execution.implementation_depth';

  function expectNoScoreFields(report: ScoreReport, id: string) {
    const d = dimension(report, id);
    expect(d.state).toBe('insufficient_evidence');
    expect(Object.keys(d).filter((key) => /score|judged|suppressed|value/i.test(key))).toEqual([]);
    expect(JSON.stringify(d)).not.toMatch(/score/i);
  }

  it('no citations at all', () => {
    const g = baseWorld();
    const ctx = makeContext(g.build(), lockedSnapshot());
    const report = run(ctx, fallbackPayload([scored(DIM, 3)]));
    expectNoScoreFields(report, DIM);
    const d = dimension(report, DIM);
    expect(d.state === 'insufficient_evidence' && d.reason).toBe('no_usable_citation');
    const diagnostic = report.diagnostics.find((entry) => entry.code === 'JUDGED_VALUE_NOT_USED');
    expect(diagnostic?.path).toBe(`dimensions.${DIM}`);
    expect(diagnostic?.message).toContain('not used');
    expect(Object.keys(diagnostic ?? {}).sort()).toEqual(['code', 'entityIds', 'message', 'path']);
  });

  it.each(['absence', 'unknown'] as const)(
    'only %s evidence is cited: missing evidence is not negative evidence',
    (kind) => {
      const g = baseWorld();
      const id = eid();
      g.addEvidence({ id, origin: 'github', kind, label: 'unverified', snapshotId: IDS.github });
      const ctx = makeContext(g.build(), lockedSnapshot());
      const report = run(ctx, fallbackPayload([scored(DIM, 1, cite(id))]));
      expectNoScoreFields(report, DIM);
      expect(dimension(report, DIM).citedEvidenceIds).toEqual([id]);
      // The judged 1 contributes nothing: no criterion carries it.
      const c = criterion(report, 'technical_execution');
      expect(c.state).toBe('insufficient_evidence');
      expect('score10' in c).toBe(false);
    },
  );

  it('is excluded from the criterion, not zero-filled into it', () => {
    const g = baseWorld();
    const dev = devpostEvidence(g, eid());
    const absent = eid();
    g.addEvidence({
      id: absent,
      origin: 'github',
      kind: 'absence',
      label: 'unverified',
      snapshotId: IDS.github,
    });
    const ctx = makeContext(g.build(), lockedSnapshot());
    const report = run(
      ctx,
      fallbackPayload([
        scored('technical_execution.implementation_depth', 7, cite(dev)),
        scored('technical_execution.architecture_integration', 7, cite(dev)),
        scored('technical_execution.technical_ownership', 0, cite(absent)),
        scored('technical_execution.correctness_robustness', 7, cite(dev)),
        scored('technical_execution.engineering_challenge', 7, cite(dev)),
      ]),
    );
    const c = aggregated(report, 'technical_execution');
    expect(c.state).toBe('partial');
    expect('score10' in c && c.score10).toBe(7);
    expect(c.assessedWeightShare).toBe(0.8);
  });

  it('an assessor-reported insufficient dimension is its own reason', () => {
    const g = baseWorld();
    const ctx = makeContext(g.build(), lockedSnapshot());
    const report = run(ctx, fallbackPayload([]));
    const d = dimension(report, DIM);
    expect(d.state === 'insufficient_evidence' && d.reason).toBe('assessor_reported_insufficient');
    expect(d.confidence).toBe(0);
    expect(report.diagnostics.some((x) => x.code === 'JUDGED_VALUE_NOT_USED')).toBe(false);
  });
});

describe('E11 / E12: insufficient dimensions and criteria', () => {
  function worldWithDevpost() {
    const g = baseWorld();
    const dev = devpostEvidence(g, eid());
    return { g, dev, ctx: makeContext(g.build(), lockedSnapshot()) };
  }

  it('E11: Technical Execution with one insufficient dimension -> 7.0000 (zero-filling would give 5.6)', () => {
    const { ctx, dev } = worldWithDevpost();
    const report = run(
      ctx,
      fallbackPayload([
        scored('technical_execution.implementation_depth', 7, cite(dev)),
        scored('technical_execution.architecture_integration', 8, cite(dev)),
        insufficient('technical_execution.technical_ownership'),
        scored('technical_execution.correctness_robustness', 6, cite(dev)),
        scored('technical_execution.engineering_challenge', 7, cite(dev)),
      ]),
    );
    const c = aggregated(report, 'technical_execution');
    expect(c.state).toBe('partial');
    expect('score10' in c && c.score10).toBe(7);
    expect(c.assessedWeightShare).toBe(0.8);
    expect(c.missingDimensionIds).toEqual(['technical_execution.technical_ownership']);
    expect(report.overall.state).toBe('insufficient_evidence');
  });

  it('E12: fallback overall with an insufficient criterion and a not_applicable Track -> 6.9063', () => {
    const { ctx, dev } = worldWithDevpost();
    const c = cite(dev);
    const report = run(
      ctx,
      fallbackPayload([
        ...criterionScored('technical_execution', 7, c),
        ...criterionScored('completion_functionality', 6.5, c),
        ...criterionScored('innovation_creativity', 8, c),
        ...criterionScored('impact_problem_fit', 7.5, c),
        ...criterionScored('demo_communication', 5, c),
      ]),
    );
    expect(report.overall).toMatchObject({
      state: 'scored_partial',
      weightBasis: 'fallback',
      score10: 6.9063,
      scoreOnScale: 6.9063,
      assessedWeightShare: 0.8889,
      missingCriterionKeys: ['design_user_experience'],
    });
    expect(criterion(report, 'design_user_experience').state).toBe('insufficient_evidence');
    expect(criterion(report, 'track_prize_alignment')).toEqual({
      key: 'track_prize_alignment',
      name: 'Track / Prize Alignment',
      weight: 0.1,
      state: 'not_applicable',
      reason: 'no_declared_tracks',
    });
    expect(report.rubric).toMatchObject({
      source: 'universal_fallback',
      official: false,
      weightBasis: 'fallback',
    });
    // The not_applicable criterion has no dimensions in the report.
    expect(report.dimensions.some((d) => d.criterionKey === 'track_prize_alignment')).toBe(false);
  });

  it('with a declared track the Track criterion is judged like any other', () => {
    const g = baseWorld();
    const dev = devpostEvidence(g, eid());
    const ctx = makeContext(g.build(), lockedSnapshot({ trackKeys: ['ai_track'] }), {
      declaredTrackKeys: ['ai_track'],
    });
    const report = run(
      ctx,
      fallbackPayload(criterionScored('track_prize_alignment', 6, cite(dev)), { withTrack: true }),
    );
    expect(criterion(report, 'track_prize_alignment').state).toBe('assessed');
    expect(report.overall.state).toBe('insufficient_evidence');
  });

  it('every criterion fully assessed -> overall `scored` with the published weights as they are', () => {
    const { ctx, dev } = worldWithDevpost();
    const c = cite(dev);
    const report = run(
      ctx,
      fallbackPayload([
        ...criterionScored('technical_execution', 8, c),
        ...criterionScored('completion_functionality', 8, c),
        ...criterionScored('innovation_creativity', 8, c),
        ...criterionScored('impact_problem_fit', 8, c),
        ...criterionScored('design_user_experience', 8, c),
        ...criterionScored('demo_communication', 8, c),
      ]),
    );
    expect(report.overall).toMatchObject({
      state: 'scored',
      score10: 8,
      assessedWeightShare: 1,
      missingCriterionKeys: [],
    });
  });

  it('a project with every dimension insufficient has no score anywhere', () => {
    const { ctx } = worldWithDevpost();
    const report = run(ctx, fallbackPayload([]));
    expect(report.overall.state).toBe('insufficient_evidence');
    expect('score10' in report.overall).toBe(false);
    for (const entry of report.criteria) {
      if (entry.state !== 'not_applicable') expect(entry.state).toBe('insufficient_evidence');
    }
  });
});

describe('E13 / E14: official rubrics', () => {
  it('E13: scale 1-5 with weights 0.6 / 0.4: judgments 4 and 2 -> 5.5 (3.2 on the official scale, assuming linearity)', () => {
    const g = baseWorld();
    const dev = devpostEvidence(g, eid());
    const rubric = rubricDefinition({
      scaleMin: 1,
      scaleMax: 5,
      criteria: [
        { key: 'innovation', weight: 0.6 },
        { key: 'execution', weight: 0.4 },
      ],
    });
    const ctx = makeContext(g.build(), lockedSnapshot({ rubrics: [rubric] }));
    const report = run(
      ctx,
      payload(
        scored('official.innovation', 4, cite(dev)),
        scored('official.execution', 2, cite(dev)),
      ),
    );
    expect(assessed(report, 'official.innovation')).toMatchObject({
      scoreOnScale: 4,
      score10: 7.5,
    });
    expect(assessed(report, 'official.execution')).toMatchObject({ scoreOnScale: 2, score10: 2.5 });
    expect(report.overall).toMatchObject({
      state: 'scored',
      weightBasis: 'official',
      score10: 5.5,
      scoreOnScale: 3.2,
    });
    expect(report.rubric).toMatchObject({
      official: true,
      source: 'official_event_context',
      weightBasis: 'official',
      scale: { min: 1, max: 5 },
    });
    expect(criterion(report, 'innovation')).toMatchObject({
      weight: 0.6,
      state: 'assessed',
      score10: 7.5,
      scoreOnScale: 4,
    });
  });

  it('retains published official weights exactly, without renormalizing, even when they sum to 1 within tolerance', () => {
    const g = baseWorld();
    const dev = devpostEvidence(g, eid());
    const rubric = rubricDefinition({
      criteria: [
        { key: 'a', weight: 0.3333333 },
        { key: 'b', weight: 0.3333333 },
        { key: 'c', weight: 0.3333334 },
      ],
    });
    const ctx = makeContext(g.build(), lockedSnapshot({ rubrics: [rubric] }));
    const report = run(
      ctx,
      payload(...['a', 'b', 'c'].map((key) => scored(`official.${key}`, 10, cite(dev)))),
    );
    expect(report.criteria.map((c) => c.weight)).toEqual([0.3333333, 0.3333333, 0.3333334]);
    expect(report.overall).toMatchObject({ state: 'scored', score10: 10 });
  });

  describe('unweighted official rubric (E14)', () => {
    const rubric3 = rubricDefinition({
      criteria: [
        { key: 'innovation', weight: null },
        { key: 'execution', weight: null },
        { key: 'presentation', weight: null },
      ],
    });
    function unweighted(rubric = rubric3) {
      const g = baseWorld();
      const dev = devpostEvidence(g, eid());
      return { dev, ctx: makeContext(g.build(), lockedSnapshot({ rubrics: [rubric] })) };
    }

    it('never creates an official overall number: per-criterion scores only, overall not_computed', () => {
      const { ctx, dev } = unweighted();
      const report = run(
        ctx,
        payload(
          scored('official.innovation', 8, cite(dev)),
          scored('official.execution', 6, cite(dev)),
          insufficient('official.presentation'),
        ),
      );
      expect(report.overall).toEqual({
        state: 'not_computed',
        weightBasis: 'unweighted_official',
        reason: 'unweighted_official_rubric',
      });
      expect(report.unofficialPreview).toBeNull();
      expect(criterion(report, 'innovation')).toMatchObject({
        weight: null,
        state: 'assessed',
        score10: 8,
      });
      expect(criterion(report, 'execution')).toMatchObject({ state: 'assessed', score10: 6 });
      expect(criterion(report, 'presentation').state).toBe('insufficient_evidence');
      expect(report.rubric).toMatchObject({ weightBasis: 'unweighted_official', official: true });
    });

    it('offers the visibly unofficial equal-weight preview only on explicit request: 7.0 at share 0.6667', () => {
      const { ctx, dev } = unweighted();
      const body = payload(
        scored('official.innovation', 8, cite(dev)),
        scored('official.execution', 6, cite(dev)),
        insufficient('official.presentation'),
      );
      const report = run(ctx, body, { unweightedPreview: 'equal_weight' });
      expect(report.overall.state).toBe('not_computed');
      expect(report.unofficialPreview).toMatchObject({
        kind: 'unofficial_equal_weight_preview',
        official: false,
        weightBasis: 'equal_assumed',
        state: 'scored_partial',
        score10: 7,
        assessedWeightShare: 0.6667,
        missingCriterionKeys: ['presentation'],
      });
      expect(report.unofficialPreview?.notice).toContain('UNOFFICIAL');
      // It never leaks into the official fields.
      expect(JSON.stringify(report.overall)).not.toContain('equal');
    });

    it('2 of 4 assessed criteria (share 0.5) -> the preview is insufficient_evidence, still no number', () => {
      const rubric4 = rubricDefinition({
        criteria: ['a', 'b', 'c', 'd'].map((key) => ({ key, weight: null })),
      });
      const { ctx, dev } = unweighted(rubric4);
      const report = run(
        ctx,
        payload(
          scored('official.a', 9, cite(dev)),
          scored('official.b', 5, cite(dev)),
          insufficient('official.c'),
          insufficient('official.d'),
        ),
        { unweightedPreview: 'equal_weight' },
      );
      expect(report.unofficialPreview).toMatchObject({
        state: 'insufficient_evidence',
        assessedWeightShare: 0.5,
      });
      expect(report.unofficialPreview && 'score10' in report.unofficialPreview).toBe(false);
    });

    it('a fully assessed unweighted rubric: preview is the plain mean and says `scored`', () => {
      const { ctx, dev } = unweighted();
      const report = run(
        ctx,
        payload(
          scored('official.innovation', 9, cite(dev)),
          scored('official.execution', 6, cite(dev)),
          scored('official.presentation', 3, cite(dev)),
        ),
        { unweightedPreview: 'equal_weight' },
      );
      expect(report.unofficialPreview).toMatchObject({
        state: 'scored',
        score10: 6,
        assessedWeightShare: 1,
      });
      expect(report.overall.state).toBe('not_computed');
    });
  });

  it('a weighted official overall is `official`-based and a criterion absent from tracks stays in the rubric', () => {
    const g = baseWorld();
    const dev = devpostEvidence(g, eid());
    const rubric = rubricDefinition({
      criteria: [
        { key: 'track_prize_alignment', weight: 0.5 },
        { key: 'execution', weight: 0.5 },
      ],
    });
    const ctx = makeContext(g.build(), lockedSnapshot({ rubrics: [rubric] }), {
      declaredTrackKeys: [],
    });
    const report = run(
      ctx,
      payload(
        insufficient('official.track_prize_alignment'),
        scored('official.execution', 6, cite(dev)),
      ),
    );
    // Not removed: it is an ordinary insufficient criterion, so the overall share is only 0.5.
    expect(criterion(report, 'track_prize_alignment').state).toBe('insufficient_evidence');
    expect(report.overall).toMatchObject({
      state: 'insufficient_evidence',
      assessedWeightShare: 0.5,
    });
  });
});

describe('contradiction visibility and lineage', () => {
  it('lists recorded contradictions that map to no dimension, and never claims completeness', () => {
    const { ctx, ids } = flowWorld((g) => {
      const a = eid();
      const b = eid();
      devpostEvidence(g, a);
      devpostEvidence(g, b);
      g.contradict(uid(1, 'd6000010'), { type: 'evidence', id: a }, { type: 'evidence', id: b });
    });
    const report = run(ctx, fallbackPayload([scored(FLOW, 7, ...flowCitations(ids))]));
    const unmapped = report.diagnostics.find((d) => d.code === 'UNMAPPED_CONTRADICTION');
    expect(unmapped?.entityIds).toEqual([uid(1, 'd6000010')]);
    expect(assessed(report, FLOW).confidence).toBe(0.6);
    expect(report.notices.contradictionCoverage).toBe('recorded_only');
  });

  it('a graph with no recorded contradictions still carries the not-complete notice', () => {
    const { ctx, ids } = flowWorld();
    const report = run(ctx, fallbackPayload([scored(FLOW, 7, ...flowCitations(ids))]));
    expect(report.diagnostics.some((d) => d.code === 'UNMAPPED_CONTRADICTION')).toBe(false);
    expect(report.notices).toEqual({
      contradictionCoverage: 'recorded_only',
      semanticRelevance: 'not_verified',
      claimLabels: 'never_proof_of_truth',
      parameterStatus: 'heuristic_not_calibrated',
      confidenceMeaning: 'index_not_probability',
    });
  });

  it('F5: a successor claim cannot launder an earlier contradiction; it still counts and is visible as lineage', () => {
    const c1 = uid(1, 'c6000020');
    const c2 = uid(2, 'c6000020');
    const c3 = uid(3, 'c6000020');
    const { ctx, ids } = flowWorld((g, { code }) => {
      const other = eid();
      devpostEvidence(g, other);
      g.addClaim({ id: c1, label: 'repo_corroborated' })
        .addClaim({ id: c2, label: 'contradicted', supersedesId: c1 })
        .addClaim({ id: c3, label: 'team_claim', supersedesId: c2 })
        .relate(c3, code)
        .contradict(uid(1, 'd6000020'), { type: 'claim', id: c2 }, { type: 'evidence', id: other });
    });
    const report = run(ctx, fallbackPayload([scored(FLOW, 7, ...flowCitations(ids))]));
    const d = assessed(report, FLOW);
    expect(d.contradictionIds).toEqual([uid(1, 'd6000020')]);
    expect(d.confidence).toBe(0.42);
    expect(d.score10).toBe(7);
    expect(report.claimLineages).toEqual([
      {
        headClaimId: c3,
        claimIds: [c1, c2, c3],
        recordedLevels: ['repo_corroborated', 'contradicted', 'team_claim'],
        everContradicted: true,
        contradictionIds: [uid(1, 'd6000020')],
      },
    ]);
    expect(
      report.diagnostics.find((x) => x.code === 'LINEAGE_CONTRADICTION_IN_HISTORY')?.entityIds,
    ).toEqual([c1, c2, c3]);
  });

  it('a historic maximum never raises trust: the lineage shows labels, no formula reads them', () => {
    const { ctx, ids } = flowWorld((g, { code }) => {
      g.addClaim({ id: uid(1, 'c6000021'), label: 'judge_verified' }).relate(
        uid(1, 'c6000021'),
        code,
      );
    });
    const report = run(ctx, fallbackPayload([scored(FLOW, 7, ...flowCitations(ids))]));
    expect(assessed(report, FLOW).confidence).toBe(0.6);
  });
});

describe('claim labels never matter', () => {
  it('flipping every claim label leaves every score, strength, coverage and confidence unchanged', () => {
    const labels = [
      'unverified',
      'team_claim',
      'repo_corroborated',
      'machine_verified',
      'judge_verified',
      'live_verified',
      'contradicted',
    ] as const;
    const reports = labels.map((label) => {
      counter = 5000; // identical evidence IDs in every run
      const { ctx, ids } = flowWorld((g, { code, dev }) => {
        const claim = uid(1, 'c6000030');
        g.addClaim({ id: claim, label }).relate(claim, code).relate(claim, dev);
      });
      return run(ctx, fallbackPayload([scored(FLOW, 7, ...flowCitations(ids))]));
    });
    const reference = reports[0];
    if (!reference) throw new Error('no report');
    for (const report of reports) {
      expect(report.dimensions).toEqual(reference.dimensions);
      expect(report.criteria).toEqual(reference.criteria);
      expect(report.overall).toEqual(reference.overall);
    }
  });
});

describe('output safety', () => {
  it('official and unofficial results are distinguishable', () => {
    const g = baseWorld();
    const dev = devpostEvidence(g, eid());
    const official = makeContext(
      g.build(),
      lockedSnapshot({ rubrics: [rubricDefinition({ criteria: [{ key: 'a', weight: 1 }] })] }),
    );
    const fallback = makeContext(g.build(), lockedSnapshot());
    const a = run(official, payload(scored('official.a', 5, cite(dev))));
    const b = run(fallback, fallbackPayload([]));
    expect(a.rubric).toMatchObject({
      official: true,
      source: 'official_event_context',
      rubricVersion: null,
    });
    expect(b.rubric).toMatchObject({
      official: false,
      source: 'universal_fallback',
      rubricVersion: 'fallback-rubric/v1',
    });
    expect('weightBasis' in a.overall && a.overall.weightBasis).toBe('official');
    expect('weightBasis' in b.overall && b.overall.weightBasis).toBe('fallback');
  });

  it('every report parses against its own strict schema and the dimension list has no score on an insufficient one', () => {
    const { ctx, ids } = flowWorld();
    const report = run(ctx, fallbackPayload([scored(FLOW, 7, ...flowCitations(ids))]));
    expect(report.dimensions).toHaveLength(31);
    for (const d of report.dimensions.filter((entry) => entry.state === 'insufficient_evidence')) {
      expect('score10' in d).toBe(false);
      expect('scoreOnScale' in d).toBe(false);
      expect(d.confidence).toBe(0);
    }
  });
});
