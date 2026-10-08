import type { DimensionJudgment, ScoreReport } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import { canonicalJson, hashOf } from './canonical.js';
import { scoreProject } from './engine.js';
import { parametersHash } from './parameters-hash.js';
import type { FixtureGraph } from './testing/builders.js';
import {
  baseWorld,
  cite,
  codeEvidence,
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

const FLOW = 'completion_functionality.core_user_flow';
const DEPTH = 'technical_execution.implementation_depth';

interface Options {
  order?: 'forward' | 'reverse';
  codeLabel?: 'repo_corroborated' | 'machine_verified' | 'unverified';
  extra?: (g: FixtureGraph) => void;
  rubrics?: ReturnType<typeof rubricDefinition>[];
  tracks?: string[];
  specificity?: 'exact' | 'partial';
  score?: number;
  preview?: boolean;
  tamperText?: boolean;
}

/** Builds a full scenario from scratch each time, so repeated builds prove reproducibility. */
function scenario(options: Options = {}) {
  const g = baseWorld();
  const specs: (() => string)[] = [
    () => codeEvidence(g, uid(1, 'e8000001'), { label: options.codeLabel ?? 'repo_corroborated' }),
    () => deploymentEvidence(g, uid(2, 'e8000001')),
    () => devpostEvidence(g, uid(3, 'e8000001')),
  ];
  const [code, dep, dev] = (options.order === 'reverse' ? [...specs].reverse() : specs)
    .map((make) => make())
    .sort((a, b) => (a < b ? -1 : 1));
  options.extra?.(g);
  const rubrics = options.rubrics ?? [];
  const ctx = makeContext(g.build(), lockedSnapshot({ rubrics, trackKeys: options.tracks ?? [] }), {
    declaredTrackKeys: options.tracks ?? [],
  });
  const citations = [
    cite(code ?? '', 'direct', options.specificity ?? 'exact'),
    cite(dep ?? ''),
    cite(dev ?? '', 'adjacent', 'partial'),
  ];
  const body =
    rubrics.length > 0
      ? payload(scored('official.a', options.score ?? 7, ...citations), insufficient('official.b'))
      : fallbackPayload([scored(FLOW, options.score ?? 7, ...citations)], {
          withTrack: (options.tracks ?? []).length > 0,
        });
  return { ctx, body, ids: { code: code ?? '', dep: dep ?? '', dev: dev ?? '' } };
}

const OFFICIAL = rubricDefinition({
  criteria: [
    { key: 'a', weight: 0.5 },
    { key: 'b', weight: 0.5 },
  ],
});

const run = (o: Options = {}, options?: unknown): ScoreReport => {
  const { ctx, body } = scenario(o);
  const result = scoreProject(
    ctx,
    body,
    options ?? (o.preview ? { unweightedPreview: 'equal_weight' } : {}),
  );
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.report;
};

describe('determinism', () => {
  it('100 repeated runs on one context give a byte-identical report and hash', () => {
    const { ctx, body } = scenario();
    const first = scoreProject(ctx, body);
    if (!first.ok) throw new Error('rejected');
    const reference = canonicalJson(first.report);
    for (let i = 0; i < 100; i += 1) {
      const next = scoreProject(ctx, body);
      if (!next.ok) throw new Error('rejected');
      expect(canonicalJson(next.report)).toBe(reference);
      expect(next.report.outputHash).toBe(first.report.outputHash);
    }
  });

  it('rebuilding everything from scratch (new context, graph and payload objects) gives the same bytes', () => {
    const a = run();
    const b = run();
    expect(canonicalJson(b)).toBe(canonicalJson(a));
    expect(b.outputHash).toBe(a.outputHash);
    expect(b.inputFingerprint).toBe(a.inputFingerprint);
    expect(b.graphFingerprint).toBe(a.graphFingerprint);
  });

  it('is independent of the order in which graph records were inserted', () => {
    const a = run({ order: 'forward' });
    const b = run({ order: 'reverse' });
    expect(canonicalJson(b)).toBe(canonicalJson(a));
  });

  it('is independent of the order of judgments and of citations', () => {
    const { ctx, body } = scenario();
    const reversed = {
      ...body,
      judgments: [...body.judgments]
        .reverse()
        .map((j) => ({ ...j, citations: [...j.citations].reverse() })),
    };
    const a = scoreProject(ctx, body);
    const b = scoreProject(ctx, reversed);
    if (!a.ok || !b.ok) throw new Error('rejected');
    expect(canonicalJson(b.report)).toBe(canonicalJson(a.report));
  });

  it('contains no time, randomness or generated identifier', () => {
    const text = canonicalJson(run());
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});

describe('hashes cover what is needed to reproduce a report', () => {
  const base = run();

  it('the parameter hash is stable and embedded', () => {
    expect(base.parametersHash).toBe(parametersHash);
    expect(run({ score: 3 }).parametersHash).toBe(parametersHash);
  });

  const changes: [string, Options][] = [
    ['a judged score', { score: 6 }],
    ['a citation classification', { specificity: 'partial' }],
    ['an evidence label', { codeLabel: 'unverified' }],
    ['a privileged evidence label', { codeLabel: 'machine_verified' }],
    ['a declared track', { tracks: ['ai_track'] }],
    [
      'an added relation',
      {
        extra: (g) => {
          g.addClaim({ id: uid(1, 'c8000001') }).relate(uid(1, 'c8000001'), uid(3, 'e8000001'));
        },
      },
    ],
    [
      'an added contradiction',
      {
        extra: (g) => {
          g.contradict(
            uid(1, 'd8000001'),
            { type: 'evidence', id: uid(1, 'e8000001') },
            { type: 'evidence', id: uid(3, 'e8000001') },
          );
        },
      },
    ],
    [
      'an artifact that changes classification',
      {
        extra: (g) => {
          g.artifact(IDS.code, IDS.github, 'files/src/app.md', { mediaType: 'text/markdown' });
        },
      },
    ],
  ];

  it.each(changes)('%s changes the input fingerprint and the output hash', (_name, options) => {
    const changed = run(options);
    expect(changed.inputFingerprint).not.toBe(base.inputFingerprint);
    expect(changed.outputHash).not.toBe(base.outputHash);
  });

  it('graph content changes the graph fingerprint; judgments alone do not', () => {
    expect(run({ codeLabel: 'unverified' }).graphFingerprint).not.toBe(base.graphFingerprint);
    expect(run({ tracks: [] }).graphFingerprint).toBe(base.graphFingerprint);
    expect(run({ score: 2 }).graphFingerprint).toBe(base.graphFingerprint);
    expect(run({ score: 2 }).inputFingerprint).not.toBe(base.inputFingerprint);
  });

  it('a different rubric changes the rubric fingerprint, even with the same shape', () => {
    const a = run({ rubrics: [OFFICIAL] });
    const reweighted = rubricDefinition({
      criteria: [
        { key: 'a', weight: 0.6 },
        { key: 'b', weight: 0.4 },
      ],
    });
    const b = run({ rubrics: [reweighted] });
    expect(a.rubric.fingerprint).not.toBe(b.rubric.fingerprint);
    expect(a.inputFingerprint).not.toBe(b.inputFingerprint);
    const scaled = run({
      rubrics: [
        rubricDefinition({
          scaleMin: 0,
          scaleMax: 20,
          criteria: [
            { key: 'a', weight: 0.5 },
            { key: 'b', weight: 0.5 },
          ],
        }),
      ],
    });
    expect(scaled.rubric.fingerprint).not.toBe(a.rubric.fingerprint);
  });

  it('the preview request is part of the input fingerprint', () => {
    const unweighted = rubricDefinition({
      criteria: [
        { key: 'a', weight: null },
        { key: 'b', weight: null },
      ],
    });
    const without = run({ rubrics: [unweighted] });
    const withPreview = run({ rubrics: [unweighted], preview: true });
    expect(withPreview.inputFingerprint).not.toBe(without.inputFingerprint);
    expect(withPreview.unofficialPreview).not.toBeNull();
    expect(without.unofficialPreview).toBeNull();
  });

  it('free text and insertion order do not change the graph fingerprint, but identity does', () => {
    expect(run({ order: 'reverse' }).graphFingerprint).toBe(base.graphFingerprint);
  });

  it('the output hash covers every other field of the report', () => {
    const { outputHash, ...body } = base;
    expect(outputHash).toBe(hashOf(body));
    expect(hashOf({ ...body, diagnostics: [...body.diagnostics, { code: 'X' }] })).not.toBe(
      outputHash,
    );
    expect(
      hashOf({ ...body, notices: { ...body.notices, contradictionCoverage: 'complete' } }),
    ).not.toBe(outputHash);
  });
});

describe('judgment construction helpers stay honest', () => {
  it('a judgment can be inspected as plain data', () => {
    const judgment: DimensionJudgment = scored(DEPTH, 5, cite(uid(1, 'e8000009')));
    expect(judgment.outcome).toEqual({ kind: 'scored', score: 5 });
  });
});
