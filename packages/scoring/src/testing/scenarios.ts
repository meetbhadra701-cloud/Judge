/*
 * Named, hand-authored golden scenarios. Every judgment here is explicit TEST DATA written by hand;
 * nothing is a model output and nothing pretends to be real judging. Used by the golden tests and by
 * the cross-process determinism check.
 */
import type { DimensionJudgment } from '@judge-copilot/schemas';
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
  type FixtureGraph,
} from './builders.js';
import type { TrustedScoringContext } from '../context.js';

export interface GoldenScenario {
  readonly name: string;
  readonly context: TrustedScoringContext;
  readonly body: ReturnType<typeof payload>;
  readonly options?: unknown;
}

const FLOW = 'completion_functionality.core_user_flow';
let n = 0;
const id = () => uid((n += 1), 'e0a00001');

function flowEvidence(g: FixtureGraph) {
  return {
    code: codeEvidence(g, id()),
    dep: deploymentEvidence(g, id()),
    dev: devpostEvidence(g, id()),
  };
}
const flowCites = (e: { code: string; dep: string; dev: string }) => [
  cite(e.code),
  cite(e.dep),
  cite(e.dev, 'adjacent', 'partial'),
];

export function goldenScenarios(): GoldenScenario[] {
  n = 0;
  const scenarios: GoldenScenario[] = [];
  const add = (scenario: GoldenScenario) => scenarios.push(scenario);

  // 1. Official weighted rubric on a 1-5 scale (E13).
  {
    const g = baseWorld();
    const dev = devpostEvidence(g, id());
    const code = codeEvidence(g, id());
    const rubric = rubricDefinition({
      scaleMin: 1,
      scaleMax: 5,
      name: 'Official judging rubric',
      criteria: [
        { key: 'innovation', name: 'Innovation', weight: 0.6 },
        { key: 'execution', name: 'Execution', weight: 0.4 },
      ],
    });
    add({
      name: 'official-weighted-scale-1-5',
      context: makeContext(g.build(), lockedSnapshot({ rubrics: [rubric] })),
      body: payload(
        scored('official.innovation', 4, cite(code), cite(dev, 'adjacent', 'partial')),
        scored('official.execution', 2, cite(dev)),
      ),
    });
  }

  // 2 & 3. Official UNWEIGHTED rubric: no official overall; then the explicit unofficial preview (E14).
  for (const preview of [false, true]) {
    const g = baseWorld();
    const dev = devpostEvidence(g, id());
    const rubric = rubricDefinition({
      criteria: [
        { key: 'innovation', weight: null },
        { key: 'execution', weight: null },
        { key: 'presentation', weight: null },
      ],
    });
    add({
      name: preview ? 'official-unweighted-with-unofficial-preview' : 'official-unweighted',
      context: makeContext(g.build(), lockedSnapshot({ rubrics: [rubric] })),
      body: payload(
        scored('official.innovation', 8, cite(dev)),
        scored('official.execution', 6, cite(dev)),
        insufficient('official.presentation'),
      ),
      ...(preview ? { options: { unweightedPreview: 'equal_weight' } } : {}),
    });
  }

  // 4. Permitted fallback, no declared tracks: a gap and a not_applicable Track criterion (E12).
  {
    const g = baseWorld();
    const dev = devpostEvidence(g, id());
    const c = cite(dev);
    add({
      name: 'fallback-no-tracks-with-gaps',
      context: makeContext(g.build(), lockedSnapshot()),
      body: fallbackPayload([
        ...criterionScored('technical_execution', 7, c),
        ...criterionScored('completion_functionality', 6.5, c),
        ...criterionScored('innovation_creativity', 8, c),
        ...criterionScored('impact_problem_fit', 7.5, c),
        ...criterionScored('demo_communication', 5, c),
      ]),
    });
  }

  // 5. Fallback with a declared track: the Track criterion is judged.
  {
    const g = baseWorld();
    const dev = devpostEvidence(g, id());
    const code = codeEvidence(g, id());
    const c = cite(dev);
    const judgments: DimensionJudgment[] = [
      ...criterionScored('technical_execution', 7, cite(code)),
      ...criterionScored('completion_functionality', 6, c),
      ...criterionScored('innovation_creativity', 7, c),
      ...criterionScored('impact_problem_fit', 8, c),
      ...criterionScored('design_user_experience', 6, c),
      ...criterionScored('demo_communication', 5, c),
      ...criterionScored('track_prize_alignment', 7, cite(code), c),
    ];
    add({
      name: 'fallback-with-declared-track',
      context: makeContext(g.build(), lockedSnapshot({ trackKeys: ['ai_track'] }), {
        declaredTrackKeys: ['ai_track'],
      }),
      body: fallbackPayload(judgments, { withTrack: true }),
    });
  }

  // 6. Missing evidence: one insufficient dimension inside Technical Execution (E11).
  {
    const g = baseWorld();
    const dev = devpostEvidence(g, id());
    add({
      name: 'missing-evidence-partial-criterion',
      context: makeContext(g.build(), lockedSnapshot()),
      body: fallbackPayload([
        scored('technical_execution.implementation_depth', 7, cite(dev)),
        scored('technical_execution.architecture_integration', 8, cite(dev)),
        insufficient('technical_execution.technical_ownership'),
        scored('technical_execution.correctness_robustness', 6, cite(dev)),
        scored('technical_execution.engineering_challenge', 7, cite(dev)),
      ]),
    });
  }

  // 7. Weak but well supported (E5) and 8. high quality with low confidence (E4).
  {
    const g = baseWorld();
    const e = flowEvidence(g);
    add({
      name: 'weak-but-well-supported',
      context: makeContext(g.build(), lockedSnapshot()),
      body: fallbackPayload([scored(FLOW, 3, ...flowCites(e))]),
    });
  }
  {
    const g = baseWorld();
    const dev = devpostEvidence(g, id());
    add({
      name: 'high-quality-low-confidence',
      context: makeContext(g.build(), lockedSnapshot()),
      body: fallbackPayload([
        scored('technical_execution.architecture_integration', 9, cite(dev, 'adjacent', 'partial')),
      ]),
    });
  }

  // 9. Contradictions: two recorded, a supersession-laundering chain (F5) and an unmapped one.
  {
    const g = baseWorld();
    const e = flowEvidence(g);
    const other1 = devpostEvidence(g, id());
    const other2 = devpostEvidence(g, id());
    const stray1 = devpostEvidence(g, id());
    const stray2 = devpostEvidence(g, id());
    const c1 = uid(1, 'c0a00001');
    const c2 = uid(2, 'c0a00001');
    const c3 = uid(3, 'c0a00001');
    g.addClaim({ id: c1, label: 'repo_corroborated' })
      .addClaim({ id: c2, label: 'contradicted', supersedesId: c1 })
      .addClaim({ id: c3, label: 'team_claim', supersedesId: c2 })
      .relate(c3, e.code)
      .contradict(uid(1, 'd0a00001'), { type: 'claim', id: c2 }, { type: 'evidence', id: other1 })
      .contradict(
        uid(2, 'd0a00001'),
        { type: 'evidence', id: e.dep },
        { type: 'evidence', id: other2 },
      )
      .contradict(
        uid(3, 'd0a00001'),
        { type: 'evidence', id: stray1 },
        { type: 'evidence', id: stray2 },
      );
    add({
      name: 'contradictions-lineage-and-unmapped',
      context: makeContext(g.build(), lockedSnapshot()),
      body: fallbackPayload([scored(FLOW, 7, ...flowCites(e))]),
    });
  }

  // 10. Direct-SQL privileged labels and unsupported corroboration (E9).
  {
    const g = baseWorld();
    const mv = id();
    const readme = id();
    const honest = codeEvidence(g, id());
    g.addEvidence({
      id: mv,
      origin: 'github',
      kind: 'fact',
      label: 'machine_verified',
      snapshotId: IDS.github,
      artifactId: IDS.code2,
      span: [0, 6],
    });
    g.addEvidence({
      id: readme,
      origin: 'github',
      kind: 'fact',
      label: 'repo_corroborated',
      snapshotId: IDS.github,
      artifactId: IDS.readme,
    });
    g.addClaim({ id: uid(1, 'c0a00002'), label: 'live_verified' });
    add({
      name: 'direct-sql-privileged-labels',
      context: makeContext(g.build(), lockedSnapshot()),
      body: fallbackPayload([
        scored('technical_execution.implementation_depth', 6, cite(honest)),
        scored('innovation_creativity.original_technical_contribution', 6, cite(mv)),
        scored('technical_execution.correctness_robustness', 6, cite(readme)),
      ]),
    });
  }

  // 11. Ten statements, one source (E3).
  {
    const g = baseWorld();
    const ids = Array.from({ length: 10 }, () => devpostEvidence(g, id()));
    add({
      name: 'ten-statements-one-source',
      context: makeContext(g.build(), lockedSnapshot()),
      body: fallbackPayload([
        scored('impact_problem_fit.problem_clarity', 8, ...ids.map((x) => cite(x))),
      ]),
    });
  }

  // 12. Official criteria: citation-presence proxy (E8).
  {
    const g = baseWorld();
    const code = codeEvidence(g, id());
    const dev = devpostEvidence(g, id());
    const rubric = rubricDefinition({
      criteria: [
        { key: 'a', weight: 0.5 },
        { key: 'b', weight: 0.5 },
      ],
    });
    add({
      name: 'official-citation-presence-proxy',
      context: makeContext(g.build(), lockedSnapshot({ rubrics: [rubric] })),
      body: payload(
        scored('official.a', 7, cite(code)),
        scored('official.b', 5, cite(dev, 'adjacent', 'partial')),
      ),
    });
  }

  // 13. A scored judgment with no usable citation (D10).
  {
    const g = baseWorld();
    const absent = id();
    g.addEvidence({
      id: absent,
      origin: 'github',
      kind: 'absence',
      label: 'unverified',
      snapshotId: IDS.github,
    });
    add({
      name: 'scored-without-usable-citation',
      context: makeContext(g.build(), lockedSnapshot()),
      body: fallbackPayload([
        scored('technical_execution.technical_ownership', 1, cite(absent)),
        scored('demo_communication.actual_proof_demonstration', 2),
      ]),
    });
  }

  // 14. Nothing assessed.
  {
    const g = baseWorld();
    add({
      name: 'all-insufficient',
      context: makeContext(g.build(), lockedSnapshot()),
      body: fallbackPayload([]),
    });
  }

  return scenarios;
}
