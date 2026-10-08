import { describe, expect, it } from 'vitest';
import { createTrustedScoringContext, isTrustedScoringContext } from './context.js';
import { scoreProject } from './engine.js';
import {
  baseWorld,
  cite,
  codeEvidence,
  deploymentEvidence,
  devpostEvidence,
  FixtureGraph,
  insufficient,
  IDS,
  lockedSnapshot,
  makeContext,
  OTHER_PROJECT_ID,
  payload,
  rubricDefinition,
  scored,
  uid,
} from './testing/builders.js';

const OFFICIAL = rubricDefinition({
  criteria: [
    { key: 'innovation', weight: 0.6 },
    { key: 'execution', weight: 0.4 },
  ],
});

function fixture() {
  const g = baseWorld();
  const code = codeEvidence(g, uid(1, 'e5000001'));
  const dev = devpostEvidence(g, uid(2, 'e5000001'));
  const dep = deploymentEvidence(g, uid(3, 'e5000001'));
  const ctx = makeContext(g.build(), lockedSnapshot({ rubrics: [OFFICIAL] }));
  const good = payload(
    scored('official.innovation', 8, cite(code), cite(dev, 'adjacent', 'partial')),
    scored('official.execution', 6, cite(dep)),
  );
  return { g, ctx, code, dev, dep, good };
}

const codes = (result: ReturnType<typeof scoreProject>) =>
  result.ok ? [] : result.issues.map((issue) => issue.code);

describe('the trusted context is the only way to supply trusted facts', () => {
  it('scores with a context from createTrustedScoringContext', () => {
    const { ctx, good } = fixture();
    expect(isTrustedScoringContext(ctx)).toBe(true);
    expect(scoreProject(ctx, good).ok).toBe(true);
  });

  it('refuses any object that was not created by the factory, however well-formed', () => {
    const { ctx, good } = fixture();
    const impostors: unknown[] = [
      { ...ctx },
      Object.assign({}, ctx),
      Object.create(ctx) as unknown,
      structuredClone({ projectId: ctx.projectId, declaredTrackKeys: [] }),
      JSON.parse(JSON.stringify({ projectId: ctx.projectId })),
      null,
      undefined,
      'context',
      42,
      {},
    ];
    for (const impostor of impostors) {
      const result = scoreProject(impostor as typeof ctx, good);
      expect(result.ok).toBe(false);
      expect(codes(result)).toEqual(['UNTRUSTED_CONTEXT']);
    }
  });

  it('cannot be altered after creation: the context and its rubric are frozen', () => {
    const { ctx } = fixture();
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.rubric)).toBe(true);
    expect(Object.isFrozen(ctx.rubric.criteria[0])).toBe(true);
    expect(Object.isFrozen(ctx.declaredTrackKeys)).toBe(true);
    expect(() => {
      (ctx.rubric.criteria[0] as { weight: number | null }).weight = 0.99;
    }).toThrow();
    expect(() => {
      (ctx as { rubric: unknown }).rubric = null;
    }).toThrow();
    expect(() => {
      (ctx.declaredTrackKeys as string[]).push('x');
    }).toThrow();
  });

  it('is not influenced by anything an assessor sends: the rubric, tracks and verification are not inputs', () => {
    const { ctx, good, code } = fixture();
    const baseline = scoreProject(ctx, good);
    for (const smuggled of [
      { rubric: rubricDefinition({ criteria: [{ key: 'x', weight: 1 }] }) },
      { declaredTrackKeys: ['ai_track'] },
      { attestations: [{ evidenceId: code, level: 'live_verified' }] },
      { trustedAttestations: [code] },
      { verificationOverride: { [code]: 'live_verified' } },
      { weights: { live_verified: 1, machine_verified: 1 } },
      { levelWeights: { repo_corroborated: 1 } },
      { target: { kind: 'track', trackKey: 'x' } },
    ]) {
      const result = scoreProject(ctx, { ...good, ...smuggled });
      expect(result.ok).toBe(false);
      expect(codes(result)).toContain('INVALID_INPUT');
    }
    expect(baseline.ok).toBe(true);
  });

  it('rejects the same smuggling inside a judgment or a citation', () => {
    const { ctx, good, code } = fixture();
    const judgment = (
      extra: Record<string, unknown>,
      citationExtra: Record<string, unknown> = {},
    ) =>
      payload({
        ...(scored('official.innovation', 8, { ...cite(code), ...citationExtra }) as object),
        ...extra,
      } as never);
    for (const result of [
      scoreProject(ctx, judgment({ verificationLevel: 'machine_verified' })),
      scoreProject(ctx, judgment({ weight: 1 })),
      scoreProject(ctx, judgment({ strength: 1 })),
      scoreProject(ctx, judgment({}, { verificationLevel: 'live_verified' })),
      scoreProject(ctx, judgment({}, { attested: true })),
    ]) {
      expect(codes(result)).toContain('INVALID_INPUT');
    }
    expect(scoreProject(ctx, good).ok).toBe(true);
  });

  it('options are validated: only the explicit preview request exists', () => {
    const { ctx, good } = fixture();
    expect(codes(scoreProject(ctx, good, { weights: {} }))).toContain('INVALID_INPUT');
    expect(codes(scoreProject(ctx, good, { unweightedPreview: 'official' }))).toContain(
      'INVALID_INPUT',
    );
    expect(codes(scoreProject(ctx, good, null))).toContain('INVALID_INPUT');
  });
});

describe('fail-closed input validation (nothing is scored on any issue)', () => {
  it('rejects a wrong engine version', () => {
    const { ctx, good } = fixture();
    const result = scoreProject(ctx, { ...good, engineVersion: 'scoring-engine/v2' });
    expect(codes(result)).toEqual(['ENGINE_VERSION_MISMATCH']);
  });

  it.each([null, undefined, 'x', 3, [], {}, { engineVersion: 'scoring-engine/v1' }])(
    'rejects malformed payload %j',
    (raw) => {
      const { ctx } = fixture();
      expect(scoreProject(ctx, raw).ok).toBe(false);
    },
  );

  it('rejects unknown, duplicate, missing and not-applicable dimensions', () => {
    const { ctx, code, dev } = fixture();
    expect(
      codes(
        scoreProject(
          ctx,
          payload(
            scored('official.innovation', 5, cite(code)),
            scored('official.execution', 5, cite(dev)),
            scored('official.ghost', 5, cite(dev)),
          ),
        ),
      ),
    ).toEqual(['UNKNOWN_DIMENSION']);
    expect(
      codes(
        scoreProject(
          ctx,
          payload(
            scored('official.innovation', 5, cite(code)),
            scored('official.innovation', 6, cite(code)),
            scored('official.execution', 5, cite(dev)),
          ),
        ),
      ),
    ).toEqual(['JUDGMENT_DUPLICATE']);
    expect(codes(scoreProject(ctx, payload(scored('official.innovation', 5, cite(code)))))).toEqual(
      ['JUDGMENT_MISSING'],
    );
    // A fallback-style ID does not exist in an official rubric.
    expect(
      codes(
        scoreProject(
          ctx,
          payload(scored('technical_execution.implementation_depth', 5, cite(code))),
        ),
      ),
    ).toContain('UNKNOWN_DIMENSION');
  });

  it('rejects scores outside the rubric scale and non-finite scores', () => {
    const { ctx, code, dev } = fixture();
    for (const score of [-0.0001, 10.0001, 11, -1]) {
      const result = scoreProject(
        ctx,
        payload(
          scored('official.innovation', score, cite(code)),
          scored('official.execution', 5, cite(dev)),
        ),
      );
      expect(codes(result)).toEqual(['SCORE_OUT_OF_SCALE']);
    }
    for (const score of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = scoreProject(
        ctx,
        payload(
          scored('official.innovation', score, cite(code)),
          scored('official.execution', 5, cite(dev)),
        ),
      );
      expect(result.ok).toBe(false);
    }
    // The bounds themselves are valid.
    expect(
      scoreProject(
        ctx,
        payload(
          scored('official.innovation', 0, cite(code)),
          scored('official.execution', 10, cite(dev)),
        ),
      ).ok,
    ).toBe(true);
  });

  it('enforces the OFFICIAL scale, not 0-10', () => {
    const g = baseWorld();
    const code = codeEvidence(g, uid(1, 'e5100001'));
    const rubric = rubricDefinition({
      scaleMin: 1,
      scaleMax: 5,
      criteria: [{ key: 'a', weight: 1 }],
    });
    const ctx = makeContext(g.build(), lockedSnapshot({ rubrics: [rubric] }));
    expect(codes(scoreProject(ctx, payload(scored('official.a', 0.99, cite(code)))))).toEqual([
      'SCORE_OUT_OF_SCALE',
    ]);
    expect(codes(scoreProject(ctx, payload(scored('official.a', 5.01, cite(code)))))).toEqual([
      'SCORE_OUT_OF_SCALE',
    ]);
    expect(codes(scoreProject(ctx, payload(scored('official.a', 7, cite(code)))))).toEqual([
      'SCORE_OUT_OF_SCALE',
    ]);
    expect(scoreProject(ctx, payload(scored('official.a', 1, cite(code)))).ok).toBe(true);
    expect(scoreProject(ctx, payload(scored('official.a', 5, cite(code)))).ok).toBe(true);
  });

  it('rejects invented evidence IDs (well-formed but nonexistent)', () => {
    const { ctx, dep } = fixture();
    const invented = uid(9999, 'deadbeef');
    const result = scoreProject(
      ctx,
      payload(
        scored('official.innovation', 5, cite(invented)),
        scored('official.execution', 5, cite(dep)),
      ),
    );
    expect(codes(result)).toEqual(['CITATION_UNKNOWN_EVIDENCE']);
    if (!result.ok) expect(result.issues[0]?.path).toBe('judgments[0].citations[0].evidenceId');
  });

  it('rejects evidence of another project, even when it is a real, valid evidence ID elsewhere', () => {
    const { ctx, dep } = fixture();
    const other = baseWorld();
    const foreignId = uid(7, 'e9000001');
    other.addEvidence({
      id: foreignId,
      origin: 'devpost',
      kind: 'claim',
      label: 'team_claim',
      snapshotId: IDS.devpost,
    });
    expect(other.projectId).not.toBe(OTHER_PROJECT_ID);
    const result = scoreProject(
      ctx,
      payload(
        scored('official.innovation', 5, cite(foreignId)),
        scored('official.execution', 5, cite(dep)),
      ),
    );
    expect(codes(result)).toEqual(['CITATION_UNKNOWN_EVIDENCE']);
  });

  it('rejects malformed IDs and an upper-case spelling of a real ID (no normalization, no guessing)', () => {
    const { ctx, code, dep } = fixture();
    expect(
      scoreProject(
        ctx,
        payload(
          scored('official.innovation', 5, cite('not-a-uuid')),
          scored('official.execution', 5, cite(dep)),
        ),
      ).ok,
    ).toBe(false);
    const upper = scoreProject(
      ctx,
      payload(
        scored('official.innovation', 5, cite(code.toUpperCase())),
        scored('official.execution', 5, cite(dep)),
      ),
    );
    expect(upper.ok).toBe(false);
  });

  it('rejects a duplicate citation to the same evidence ID, even with different classifications', () => {
    const { ctx, code, dep } = fixture();
    const result = scoreProject(
      ctx,
      payload(
        scored('official.innovation', 5, cite(code), cite(code, 'indirect', 'generic')),
        scored('official.execution', 5, cite(dep)),
      ),
    );
    expect(codes(result)).toEqual(['CITATION_DUPLICATE']);
    if (!result.ok) expect(result.issues[0]?.path).toBe('judgments[0].citations[1].evidenceId');
  });

  it('allows the same evidence to be cited by different dimensions', () => {
    const { ctx, code } = fixture();
    expect(
      scoreProject(
        ctx,
        payload(
          scored('official.innovation', 5, cite(code)),
          scored('official.execution', 6, cite(code)),
        ),
      ).ok,
    ).toBe(true);
  });

  it('collects every issue in a deterministic order (path, then code) and returns no report', () => {
    const { ctx, code } = fixture();
    const bad = payload(
      scored('official.innovation', 99, cite(uid(8888, 'deadbeef')), cite(code), cite(code)),
      scored('official.ghost', 1, cite(code)),
    );
    const first = scoreProject(ctx, bad);
    const second = scoreProject(ctx, bad);
    expect(first.ok).toBe(false);
    expect(first).toEqual(second);
    if (first.ok) return;
    const keys = first.issues.map((issue) => `${issue.path}|${issue.code}`);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(first.issues.map((i) => i.code))).toEqual(
      new Set([
        'SCORE_OUT_OF_SCALE',
        'CITATION_UNKNOWN_EVIDENCE',
        'CITATION_DUPLICATE',
        'UNKNOWN_DIMENSION',
        'JUDGMENT_MISSING',
      ]),
    );
    expect('report' in first).toBe(false);
  });

  it('rejects an unweighted-preview request on a weighted rubric instead of ignoring it', () => {
    const { ctx, good } = fixture();
    expect(codes(scoreProject(ctx, good, { unweightedPreview: 'equal_weight' }))).toEqual([
      'UNWEIGHTED_PREVIEW_NOT_APPLICABLE',
    ]);
  });

  it('rejects a judgment for a not-applicable fallback dimension', () => {
    const g = baseWorld();
    const dev = devpostEvidence(g, uid(1, 'e5200001'));
    const ctx = makeContext(g.build(), lockedSnapshot());
    const result = scoreProject(
      ctx,
      payload(scored('track_prize_alignment.centrality', 5, cite(dev))),
    );
    expect(codes(result)).toContain('JUDGMENT_FOR_NOT_APPLICABLE_DIMENSION');
  });
});

describe('the context itself fails closed', () => {
  const lockedOnly = lockedSnapshot({ rubrics: [OFFICIAL] });

  it('rejects a graph containing a record of another project', () => {
    const g = baseWorld();
    g.addEvidence({
      id: uid(1, 'e5300001'),
      origin: 'devpost',
      kind: 'claim',
      label: 'team_claim',
      snapshotId: IDS.devpost,
      projectId: OTHER_PROJECT_ID,
    });
    const result = createTrustedScoringContext({
      ...g.build(),
      locked: lockedOnly,
      target: { kind: 'overall' },
      declaredTrackKeys: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain('GRAPH_MIXED_PROJECTS');
  });

  it('rejects a graph whose evidence belongs to another event', () => {
    const g = baseWorld();
    g.addEvidence({
      id: uid(1, 'e5300002'),
      origin: 'devpost',
      kind: 'claim',
      label: 'team_claim',
      snapshotId: IDS.devpost,
      eventId: uid(5, 'e0000009'),
    });
    const result = createTrustedScoringContext({
      ...g.build(),
      locked: lockedOnly,
      target: { kind: 'overall' },
      declaredTrackKeys: [],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a graph with a dangling reference (structural integrity is fatal)', () => {
    const g = baseWorld();
    const dev = devpostEvidence(g, uid(1, 'e5300003'));
    g.relate(uid(404, 'c0000404'), dev);
    const result = createTrustedScoringContext({
      ...g.build(),
      locked: lockedOnly,
      target: { kind: 'overall' },
      declaredTrackKeys: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe('GRAPH_INTEGRITY_FAILED');
  });

  it('rejects provenance that the known source facts cannot back', () => {
    const g = new FixtureGraph();
    g.addEvidence({
      id: uid(1, 'e5300004'),
      origin: 'devpost',
      kind: 'claim',
      label: 'team_claim',
      snapshotId: IDS.devpost,
    });
    const result = createTrustedScoringContext({
      ...g.build(),
      locked: lockedOnly,
      target: { kind: 'overall' },
      declaredTrackKeys: [],
    });
    expect(result.ok).toBe(false);
  });

  it('reports label-only integrity findings as diagnostics, not failures', () => {
    const g = baseWorld();
    g.addClaim({ id: uid(1, 'c5300005'), label: 'live_verified' });
    const result = createTrustedScoringContext({
      ...g.build(),
      locked: lockedOnly,
      target: { kind: 'overall' },
      declaredTrackKeys: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.graphDiagnostics.map((d) => d.code)).toEqual(
        expect.arrayContaining(['UNATTESTED_PRIVILEGED_LEVEL', 'GRAPH_LABEL_NOT_JUSTIFIED']),
      );
    }
  });

  it('insufficient judgments need no citations and are accepted', () => {
    const { ctx } = fixture();
    const result = scoreProject(
      ctx,
      payload(insufficient('official.innovation'), insufficient('official.execution')),
    );
    expect(result.ok).toBe(true);
  });
});
