import type { ScoreReport } from '@judge-copilot/schemas';
import { describe, expect, it } from 'vitest';
import { createTrustedScoringContext, isTrustedScoringContext } from './context.js';
import { scoreProject } from './engine.js';
import {
  baseWorld,
  cite,
  codeEvidence,
  IDS,
  lockedSnapshot,
  makeContext,
  payload,
  rubricDefinition,
  scored,
  uid,
  type FixtureGraph,
} from './testing/builders.js';

/*
 * The trusted context takes a validated, deeply frozen SNAPSHOT of everything it consumes. These
 * tests hold the ORIGINAL caller-owned objects (Maps, arrays, records, nested artifact metadata) and
 * mutate them after the context exists, in every way the review described; the report must not change.
 */

const README_EVIDENCE = uid(1, 'e7000001');
const CODE_EVIDENCE = uid(2, 'e7000001');
const CLAIM_OLD = uid(1, 'c7000001');
const CLAIM_HEAD = uid(2, 'c7000001');
const CONTRADICTION = uid(1, 'd7000001');
const UNKNOWN = uid(1, 'd7000002');

const RUBRIC = rubricDefinition({
  criteria: [
    { key: 'a', weight: 0.5 },
    { key: 'b', weight: 0.5 },
  ],
});

function world(): FixtureGraph {
  const g = baseWorld();
  // A README that the producer labeled repo_corroborated: the engine must treat it as unverified.
  g.addEvidence({
    id: README_EVIDENCE,
    origin: 'github',
    kind: 'fact',
    label: 'repo_corroborated',
    snapshotId: IDS.github,
    artifactId: IDS.readme,
    span: [0, 10],
  });
  codeEvidence(g, CODE_EVIDENCE);
  g.addClaim({ id: CLAIM_OLD })
    .addClaim({ id: CLAIM_HEAD, supersedesId: CLAIM_OLD })
    .relate(CLAIM_HEAD, README_EVIDENCE)
    .contradict(
      CONTRADICTION,
      { type: 'claim', id: CLAIM_HEAD },
      { type: 'evidence', id: CODE_EVIDENCE },
    )
    .unknown(UNKNOWN, [CLAIM_HEAD], []);
  return g;
}

const judgments = payload(
  scored('official.a', 7, cite(README_EVIDENCE)),
  scored('official.b', 8, cite(CODE_EVIDENCE)),
);

function setup() {
  const input = world().build();
  const locked = lockedSnapshot({ rubrics: [RUBRIC] });
  const context = makeContext(input, locked);
  return { input, locked, context };
}

function report(context: ReturnType<typeof makeContext>): ScoreReport {
  const result = scoreProject(context, judgments);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.report;
}

const strengthOf = (r: ScoreReport, id: string) => {
  const found = r.dimensions.find((d) => d.id === id);
  return found && found.state === 'assessed' ? found.evidenceStrength : null;
};

/** Mutation helper: assignments to frozen objects are ignored rather than thrown, either is fine. */
const set = (target: unknown, key: string, value: unknown) => {
  try {
    Reflect.set(target as object, key, value);
  } catch {
    /* frozen */
  }
};

describe('A. mutating the caller-owned source facts cannot change a report', () => {
  it('turning the README artifact key into a source-code path cannot raise 0.15 to 0.60', () => {
    const { input, context } = setup();
    const before = report(context);
    expect(strengthOf(before, 'official.a')).toBe(0.15);

    const artifact = input.known.artifacts.get(IDS.readme);
    expect(artifact).toBeDefined();
    set(artifact, 'key', 'files/src/app.ts');
    set(artifact, 'mediaType', 'text/typescript');
    // Replacing the map entry wholesale must not matter either.
    (input.known.artifacts as Map<string, unknown>).set(IDS.readme, {
      ...artifact,
      key: 'files/src/app.ts',
    });

    const after = report(context);
    expect(strengthOf(after, 'official.a')).toBe(0.15);
    expect(after.outputHash).toBe(before.outputHash);
    expect(after.graphFingerprint).toBe(before.graphFingerprint);
  });

  it('control: the same README, with a source-code key at CREATION time, scores 0.60', () => {
    const input = world().build();
    const artifact = input.known.artifacts.get(IDS.readme);
    set(artifact, 'key', 'files/src/app.ts');
    set(artifact, 'mediaType', 'text/typescript');
    const r = report(makeContext(input, lockedSnapshot({ rubrics: [RUBRIC] })));
    expect(strengthOf(r, 'official.a')).toBe(0.6);
  });
});

describe('B. injecting data after creation cannot bypass graph-integrity validation', () => {
  it('evidence injected into the originals is not citable and changes nothing', () => {
    const { input, context } = setup();
    const before = report(context);
    const injected = uid(99, 'e7000001');
    const record = {
      ...input.graph.ordered.evidence[0],
      id: injected,
      projectId: uid(1, 'a0000002'), // a record of ANOTHER project
      provenance: {
        snapshotId: uid(77, 'f0000001'),
        artifactId: null,
        span: null,
        excerpt: null,
        contextVersionId: null,
      },
    };
    (input.graph.ordered.evidence as unknown[]).push(record);
    (input.graph.evidence as Map<string, unknown>).set(injected, record);

    const result = scoreProject(
      context,
      payload(
        scored('official.a', 7, cite(injected)),
        scored('official.b', 8, cite(CODE_EVIDENCE)),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain('CITATION_UNKNOWN_EVIDENCE');
    expect(report(context).outputHash).toBe(before.outputHash);
  });

  it('a graph whose indexes disagree with its ordered arrays is refused at creation', () => {
    const input = world().build();
    const phantom = { ...input.graph.ordered.evidence[0], id: uid(98, 'e7000001') };
    (input.graph.evidence as Map<string, unknown>).set(phantom.id, phantom);
    const result = createTrustedScoringContext({
      ...input,
      locked: lockedSnapshot({ rubrics: [RUBRIC] }),
      target: { kind: 'overall' },
      declaredTrackKeys: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain('GRAPH_INTEGRITY_FAILED');
  });

  it('records carrying a malformed field or a foreign project are refused at creation', () => {
    const input = world().build();
    set(input.graph.ordered.evidence[0], 'projectId', uid(1, 'a0000002'));
    const result = createTrustedScoringContext({
      ...input,
      locked: lockedSnapshot({ rubrics: [RUBRIC] }),
      target: { kind: 'overall' },
      declaredTrackKeys: [],
    });
    expect(result.ok).toBe(false);
  });
});

describe('C. relations, contradictions, snapshots, provenance, labels and supersession are fixed', () => {
  it('mutating every one of them in the originals leaves the report byte-identical', () => {
    const { input, context } = setup();
    const before = report(context);
    expect(before.dimensions.find((d) => d.id === 'official.a')).toMatchObject({
      contradictionIds: [CONTRADICTION],
    });

    const { ordered } = input.graph;
    for (const relation of ordered.relations) set(relation, 'type', 'contradicts');
    for (const relation of ordered.relations) set(relation, 'claimId', CLAIM_OLD);
    for (const contradiction of ordered.contradictions) {
      set(contradiction, 'sideA', { type: 'evidence', id: CODE_EVIDENCE });
      set(contradiction, 'sideB', { type: 'evidence', id: README_EVIDENCE });
    }
    for (const unknown of ordered.unknowns) {
      set(unknown, 'claimIds', []);
      set(unknown, 'evidenceIds', [CODE_EVIDENCE]);
    }
    for (const claim of ordered.claims) {
      set(claim, 'supersedesId', null);
      set(claim, 'verificationLevel', 'contradicted');
    }
    for (const item of ordered.evidence) {
      set(item, 'verificationLevel', 'judge_verified');
      set(item, 'origin', 'devpost');
      set(item, 'kind', 'claim');
      set(item.provenance, 'snapshotId', IDS.devpost);
      set(item.provenance, 'artifactId', IDS.readme);
      set(item.provenance, 'span', { start: 0, end: 1, unit: 'code_points' });
    }
    for (const snapshot of input.known.snapshots.values()) {
      set(snapshot, 'status', 'failed');
      set(snapshot, 'sourceType', 'devpost');
      set(snapshot, 'revision', null);
    }
    for (const version of input.known.contextVersions.values())
      set(version, 'status', 'superseded');
    (input.known.artifacts as Map<string, unknown>).clear();
    (input.known.snapshots as Map<string, unknown>).clear();
    (input.graph.ordered.evidence as unknown[]).length = 0;
    (input.graph.claims as Map<string, unknown>).clear();

    const after = report(context);
    expect(after).toEqual(before);
    expect(after.outputHash).toBe(before.outputHash);
  });
});

describe('D. the context exposes no mutable authoritative state', () => {
  it('has no graph or known-entity property, and every exposed value is deeply frozen', () => {
    const { context } = setup();
    expect(Object.keys(context).sort()).toEqual([
      'declaredTrackKeys',
      'eventId',
      'graphDiagnostics',
      'graphFingerprint',
      'projectId',
      'rubric',
    ]);
    expect('graph' in context).toBe(false);
    expect('known' in context).toBe(false);
    expect(Object.getOwnPropertySymbols(context)).toEqual([]);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.rubric)).toBe(true);
    expect(Object.isFrozen(context.rubric.criteria)).toBe(true);
    expect(Object.isFrozen(context.rubric.criteria[0])).toBe(true);
    expect(Object.isFrozen(context.rubric.scale)).toBe(true);
    expect(Object.isFrozen(context.declaredTrackKeys)).toBe(true);
    expect(Object.isFrozen(context.graphDiagnostics)).toBe(true);
  });

  it('attempts to mutate the exposed data fail or have no effect', () => {
    const { context } = setup();
    const before = report(context);
    set(context, 'projectId', uid(5, 'a0000009'));
    set(context.rubric.scale, 'max', 1000);
    set(context.rubric.criteria[0], 'weight', 0.9);
    set(context.rubric, 'criteria', []);
    set(context, 'graph', {});
    set(context, 'known', {});
    expect(() => {
      (context.declaredTrackKeys as string[]).push('x');
    }).toThrow();
    expect(context.declaredTrackKeys).toEqual([]);
    expect(report(context)).toEqual(before);
  });

  it('a copy of a context (spread, JSON round trip, structured clone) is refused as untrusted', () => {
    const { context } = setup();
    for (const copy of [
      { ...context },
      JSON.parse(JSON.stringify(context)) as unknown,
      structuredClone(context),
    ]) {
      expect(isTrustedScoringContext(copy)).toBe(false);
      const result = scoreProject(copy as typeof context, judgments);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues[0]?.code).toBe('UNTRUSTED_CONTEXT');
    }
  });
});

describe('E. scoring under an unchanged input fingerprint is repeatable', () => {
  it('gives the same inputFingerprint and outputHash across repeated runs and fresh contexts', () => {
    const first = setup();
    const runs = [report(first.context), report(first.context), report(first.context)];
    const fresh = [report(setup().context), report(setup().context)];
    for (const r of [...runs, ...fresh]) {
      expect(r.inputFingerprint).toBe(runs[0]?.inputFingerprint);
      expect(r.outputHash).toBe(runs[0]?.outputHash);
    }
  });

  it('is independent of the order of the caller records', () => {
    const forward = setup();
    const reversed = setup();
    const o = reversed.input.graph.ordered;
    for (const list of [o.claims, o.evidence, o.relations, o.contradictions, o.unknowns]) {
      (list as unknown[]).reverse();
    }
    const again = createTrustedScoringContext({
      ...reversed.input,
      locked: reversed.locked,
      target: { kind: 'overall' },
      declaredTrackKeys: [],
    });
    expect(again.ok).toBe(true);
    if (again.ok) expect(report(again.context).outputHash).toBe(report(forward.context).outputHash);
  });
});
