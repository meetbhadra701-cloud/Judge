import { describe, expect, it } from 'vitest';
import { buildEvidenceGraph, type EvidenceGraphRecords } from './graph.js';
import {
  claimView,
  contradictionsTouching,
  currentClaims,
  evidenceView,
  neighborhood,
  paginate,
  summarizeGraph,
  supersessionView,
  traceProvenance,
  unknownsForClaim,
} from './queries.js';
import {
  ID,
  README_TEXT,
  claimRecord,
  contradictionRecord,
  evidenceRecord,
  knownWorld,
  relationRecord,
  spanOf,
  unknownRecord,
} from './testing/builders.js';

const uuid = (prefix: string, n: number) =>
  `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const C = (n: number) => uuid('c', n);
const E = (n: number) => uuid('e', n);
const R = (n: number) => uuid('f', n);
const U = (n: number) => uuid('a', n);
const X = (n: number) => uuid('b', n);

const span = spanOf(README_TEXT, 'GET /health');

/**
 * C1 (v1) <- C2 (v2) <- C3 (v3, current); C4 stands alone.
 * E1 supports C3, E2 contradicts C3, E3 (absence) is only referenced by an Unknown.
 * U1 -> C3, E3; X1 = claim C3 vs evidence E2.
 */
function records(): EvidenceGraphRecords {
  return {
    claims: [
      claimRecord(C(1), { seq: 1 }),
      claimRecord(C(2), { seq: 2, supersedesId: C(1) }),
      claimRecord(C(3), { seq: 3, supersedesId: C(2) }),
      claimRecord(C(4), { seq: 4, verificationLevel: 'unverified' }),
    ],
    evidence: [
      evidenceRecord(E(1), {
        seq: 1,
        kind: 'fact',
        origin: 'github',
        verificationLevel: 'repo_corroborated',
        provenance: {
          snapshotId: ID.githubSnapshot,
          artifactId: ID.readme,
          span: { ...span, unit: 'code_points' },
          excerpt: 'GET /health',
        },
      }),
      evidenceRecord(E(2), {
        seq: 2,
        kind: 'fact',
        origin: 'deployment',
        verificationLevel: 'unverified',
        provenance: { snapshotId: ID.deploymentSnapshot },
      }),
      evidenceRecord(E(3), {
        seq: 3,
        kind: 'absence',
        origin: 'github',
        verificationLevel: 'unverified',
        provenance: { snapshotId: ID.githubSnapshot },
      }),
    ],
    relations: [
      relationRecord(R(1), C(3), E(1), { seq: 1 }),
      relationRecord(R(2), C(3), E(2), { seq: 2, type: 'contradicts' }),
    ],
    unknowns: [unknownRecord(U(1), { claimIds: [C(3)], evidenceIds: [E(3)] })],
    contradictions: [
      contradictionRecord(X(1), { type: 'claim', id: C(3) }, { type: 'evidence', id: E(2) }),
    ],
  };
}

const graph = () => buildEvidenceGraph(records());

describe('claim and evidence views', () => {
  it('returns a claim with its supporting and contradicting evidence, unknowns and contradictions', () => {
    const view = claimView(graph(), C(3));
    expect(view?.supporting.map((link) => link.evidence.id)).toEqual([E(1)]);
    expect(view?.contradicting.map((link) => link.evidence.id)).toEqual([E(2)]);
    expect(view?.unknowns.map((unknown) => unknown.id)).toEqual([U(1)]);
    expect(view?.contradictions.map((c) => c.id)).toEqual([X(1)]);
    expect(view?.supersession).toMatchObject({ chain: [C(1), C(2), C(3)], isCurrent: true });
  });

  it('returns null for unknown IDs rather than inventing a node', () => {
    expect(claimView(graph(), ID.nothing)).toBeNull();
    expect(evidenceView(graph(), ID.nothing, knownWorld())).toBeNull();
    expect(neighborhood(graph(), { type: 'claim', id: ID.nothing })).toBeNull();
  });

  it('returns evidence with the claims it affects and its provenance trace', () => {
    const view = evidenceView(graph(), E(1), knownWorld());
    expect(view?.supports.map((link) => link.claim.id)).toEqual([C(3)]);
    expect(view?.contradicts).toEqual([]);
    expect(view?.provenance).toMatchObject({
      kind: 'source_snapshot',
      snapshot: { id: ID.githubSnapshot, sourceType: 'github', status: 'captured' },
      artifact: { id: ID.readme, snapshotId: ID.githubSnapshot, key: 'README.md' },
      span: { ...span, unit: 'code_points' },
      excerpt: 'GET /health',
      issues: [],
    });
    // The artifact text reader is an adapter detail and never leaks into the trace.
    expect(view?.provenance.artifact).not.toHaveProperty('slice');
    expect(
      evidenceView(graph(), E(2), knownWorld())?.contradicts.map((link) => link.claim.id),
    ).toEqual([C(3)]);
  });

  it('lists the Unknowns of a claim and the contradictions touching either kind of node', () => {
    expect(unknownsForClaim(graph(), C(3)).map((u) => u.id)).toEqual([U(1)]);
    expect(unknownsForClaim(graph(), C(4))).toEqual([]);
    expect(contradictionsTouching(graph(), { type: 'claim', id: C(3) }).map((c) => c.id)).toEqual([
      X(1),
    ]);
    expect(
      contradictionsTouching(graph(), { type: 'evidence', id: E(2) }).map((c) => c.id),
    ).toEqual([X(1)]);
    expect(contradictionsTouching(graph(), { type: 'evidence', id: E(1) })).toEqual([]);
  });

  it('traces an event-context item to its frozen version and reports unresolved provenance', () => {
    const item = evidenceRecord(E(9), {
      kind: 'fact',
      origin: 'event_context',
      verificationLevel: 'unverified',
      provenance: { snapshotId: null, contextVersionId: ID.supersededVersion },
    });
    expect(traceProvenance(item, knownWorld())).toMatchObject({
      kind: 'event_context_version',
      contextVersion: { id: ID.supersededVersion, status: 'superseded' },
      issues: [],
    });
    const dangling = evidenceRecord(E(8), {
      kind: 'fact',
      origin: 'github',
      verificationLevel: 'unverified',
      provenance: { snapshotId: ID.nothing },
    });
    expect(traceProvenance(dangling, knownWorld()).issues).toEqual([
      'SNAPSHOT_NOT_FOUND: The referenced source snapshot does not exist',
    ]);
  });
});

describe('supersession', () => {
  it('walks the whole chain from any member and finds the current claim', () => {
    for (const id of [C(1), C(2), C(3)]) {
      expect(supersessionView(graph(), id)).toMatchObject({
        chain: [C(1), C(2), C(3)],
        currentId: C(3),
      });
    }
    expect(supersessionView(graph(), C(1))).toMatchObject({
      predecessorId: null,
      successorId: C(2),
      isCurrent: false,
    });
    expect(supersessionView(graph(), C(2))).toMatchObject({
      predecessorId: C(1),
      successorId: C(3),
      isCurrent: false,
    });
    expect(supersessionView(graph(), C(3))).toMatchObject({
      predecessorId: C(2),
      successorId: null,
      isCurrent: true,
    });
    expect(supersessionView(graph(), C(4))).toMatchObject({
      chain: [C(4)],
      currentId: C(4),
      isCurrent: true,
    });
  });

  it('lists current claims: those nothing supersedes, old versions stay queryable', () => {
    expect(currentClaims(graph()).map((claim) => claim.id)).toEqual([C(3), C(4)]);
    expect(graph().claims.has(C(1))).toBe(true);
  });

  it('terminates on a damaged graph with a cycle', () => {
    const cyclic = buildEvidenceGraph({
      ...records(),
      claims: [
        claimRecord(C(1), { supersedesId: C(2) }),
        claimRecord(C(2), { seq: 2, supersedesId: C(1) }),
      ],
    });
    const view = supersessionView(cyclic, C(1));
    expect(new Set(view?.chain).size).toBe(view?.chain.length);
    expect(view?.chain.length).toBeLessThanOrEqual(2);
  });

  it('follows the earliest successor deterministically if a graph ever branched', () => {
    const branched = buildEvidenceGraph({
      ...records(),
      claims: [
        claimRecord(C(1), { seq: 1 }),
        claimRecord(C(3), { seq: 3, supersedesId: C(1) }),
        claimRecord(C(2), { seq: 2, supersedesId: C(1) }),
      ],
    });
    expect(supersessionView(branched, C(1))?.successorId).toBe(C(2));
  });
});

describe('neighborhood traversal', () => {
  it('returns direct neighbors in a deterministic order with typed edges', () => {
    const result = neighborhood(graph(), { type: 'claim', id: C(3) }, { depth: 1 });
    expect(result?.nodes.map((n) => `${n.type}:${n.distance}`)).toEqual([
      'claim:0',
      'claim:1', // predecessor C2
      'evidence:1', // E1
      'evidence:1', // E2
      'unknown:1',
      'contradiction:1',
    ]);
    expect(result?.nodes.map((n) => n.id)).toEqual([C(3), C(2), E(1), E(2), U(1), X(1)]);
    expect(result?.edges.map((e) => e.kind).sort()).toEqual([
      'contradiction_side',
      'relation',
      'relation',
      'supersession',
      'unknown_reference',
    ]);
    expect(result?.truncated).toBe(false);
  });

  it('expands with depth, never revisits a node and is bounded and cycle safe', () => {
    const deep = neighborhood(graph(), { type: 'claim', id: C(3) }, { depth: 4 });
    expect(new Set(deep?.nodes.map((n) => `${n.type}:${n.id}`)).size).toBe(deep?.nodes.length);
    expect(deep?.nodes.some((n) => n.id === C(1))).toBe(true);
    expect(deep?.nodes.some((n) => n.id === C(4))).toBe(false); // unconnected
    const zero = neighborhood(graph(), { type: 'claim', id: C(3) }, { depth: 0 });
    expect(zero?.nodes).toEqual([{ type: 'claim', id: C(3), distance: 0 }]);
    const capped = neighborhood(graph(), { type: 'claim', id: C(3) }, { depth: 4, maxNodes: 3 });
    expect(capped?.nodes).toHaveLength(3);
    expect(capped?.truncated).toBe(true);
    // The requested depth is clamped to the documented maximum.
    expect(neighborhood(graph(), { type: 'claim', id: C(3) }, { depth: 99 })?.depth).toBe(4);
  });

  it('reaches Unknown and Contradiction nodes as start points', () => {
    const fromUnknown = neighborhood(graph(), { type: 'unknown', id: U(1) }, { depth: 1 });
    expect(fromUnknown?.nodes.map((n) => n.id)).toEqual([U(1), C(3), E(3)]);
    const fromContradiction = neighborhood(
      graph(),
      { type: 'contradiction', id: X(1) },
      { depth: 1 },
    );
    expect(fromContradiction?.nodes.map((n) => n.id)).toEqual([X(1), C(3), E(2)]);
  });

  it('is independent of the order records were loaded in', () => {
    const reversed = buildEvidenceGraph({
      claims: [...records().claims].reverse(),
      evidence: [...records().evidence].reverse(),
      relations: [...records().relations].reverse(),
      unknowns: records().unknowns,
      contradictions: records().contradictions,
    });
    const start = { type: 'claim', id: C(3) } as const;
    expect(neighborhood(reversed, start, { depth: 3 })).toEqual(
      neighborhood(graph(), start, { depth: 3 }),
    );
  });
});

describe('summary', () => {
  it('counts structure per vocabulary value, including zeros, and contains no score', () => {
    const summary = summarizeGraph(ID.project, graph());
    expect(summary.claims).toMatchObject({ total: 4, current: 2, superseded: 2 });
    expect(summary.claims.byVerificationLevel.map((c) => [c.value, c.count])).toEqual([
      ['unverified', 1],
      ['team_claim', 3],
      ['repo_corroborated', 0],
      ['machine_verified', 0],
      ['judge_verified', 0],
      ['live_verified', 0],
      ['contradicted', 0],
    ]);
    expect(summary.evidence.byKind.find((k) => k.value === 'absence')?.count).toBe(1);
    expect(summary.relations.byType.map((t) => [t.value, t.count])).toEqual([
      ['supports', 1],
      ['contradicts', 1],
    ]);
    expect(summary.unknowns).toMatchObject({ total: 1 });
    expect(summary.contradictions).toEqual({ total: 1 });
    expect(JSON.stringify(summary)).not.toMatch(
      /score|weight|confidence|coverage|rank|strength|penalt|cheat/i,
    );
  });

  it('summarizes an empty graph', () => {
    const empty = summarizeGraph(
      ID.project,
      buildEvidenceGraph({
        claims: [],
        evidence: [],
        relations: [],
        unknowns: [],
        contradictions: [],
      }),
    );
    expect(empty.claims).toMatchObject({ total: 0, current: 0, superseded: 0 });
    expect(empty.evidence.byOrigin.every((entry) => entry.count === 0)).toBe(true);
  });
});

describe('pagination', () => {
  const items = [5, 1, 3, 2, 4].map((seq) => ({ seq, id: `id-${String(seq)}` }));

  it('pages in insertion order with a keyset cursor', () => {
    const first = paginate(items, { limit: 2, after: 0 });
    expect(first.items.map((i) => i.seq)).toEqual([1, 2]);
    expect(first.nextAfter).toBe(2);
    const second = paginate(items, { limit: 2, after: first.nextAfter ?? 0 });
    expect(second.items.map((i) => i.seq)).toEqual([3, 4]);
    const last = paginate(items, { limit: 2, after: second.nextAfter ?? 0 });
    expect(last).toEqual({ items: [{ seq: 5, id: 'id-5' }], nextAfter: null });
    expect(paginate(items, { limit: 5, after: 0 }).nextAfter).toBeNull();
  });
});
