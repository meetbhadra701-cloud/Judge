import {
  EVIDENCE_GRAPH_LIMITS,
  EVIDENCE_KIND_VALUES,
  EVIDENCE_ORIGIN_VALUES,
  EVIDENCE_RELATION_TYPE_VALUES,
  UNKNOWN_TYPE_VALUES,
  VERIFICATION_LEVEL_VALUES,
  type ClaimDetail,
  type ClaimLink,
  type ClaimRecord,
  type ContradictionRecord,
  type EvidenceDetail,
  type EvidenceGraphSummary,
  type EvidenceLink,
  type EvidenceRecord,
  type GraphNodeRef,
  type Neighborhood,
  type ProvenanceTrace,
  type SupersessionView,
  type UnknownRecord,
} from '@judge-copilot/schemas';
import type { EvidenceGraph } from './graph.js';
import { compareBySeq, nodeKey } from './graph.js';
import { compareStrings } from './issues.js';
import type { KnownEntities } from './known.js';
import { checkProvenanceReferences } from './provenance.js';

/*
 * Deterministic graph queries over loaded records. No scoring, ranking, weighting or confidence:
 * results are plain structure, always ordered by insertion sequence (then ID), and every
 * traversal is bounded and cycle-safe.
 */

// -- Claims and evidence -----------------------------------------------------------------------

export function claimView(graph: EvidenceGraph, claimId: string): ClaimDetail | null {
  const claim = graph.claims.get(claimId);
  if (!claim) return null;
  const supporting: EvidenceLink[] = [];
  const contradicting: EvidenceLink[] = [];
  for (const relation of graph.relationsByClaim.get(claim.id) ?? []) {
    const evidence = graph.evidence.get(relation.evidenceId);
    if (!evidence) continue;
    (relation.type === 'supports' ? supporting : contradicting).push({
      relationId: relation.id,
      type: relation.type,
      evidence,
    });
  }
  const supersession = supersessionView(graph, claim.id);
  if (!supersession) return null;
  return {
    claim,
    supporting,
    contradicting,
    unknowns: unknownsForClaim(graph, claim.id),
    contradictions: contradictionsTouching(graph, { type: 'claim', id: claim.id }),
    supersession,
  };
}

export function evidenceView(
  graph: EvidenceGraph,
  evidenceId: string,
  known: KnownEntities,
): EvidenceDetail | null {
  const evidence = graph.evidence.get(evidenceId);
  if (!evidence) return null;
  const supports: ClaimLink[] = [];
  const contradicts: ClaimLink[] = [];
  for (const relation of graph.relationsByEvidence.get(evidence.id) ?? []) {
    const claim = graph.claims.get(relation.claimId);
    if (!claim) continue;
    (relation.type === 'supports' ? supports : contradicts).push({
      relationId: relation.id,
      type: relation.type,
      claim,
    });
  }
  return {
    evidence,
    supports,
    contradicts,
    unknowns: graph.unknownsByEvidence.get(evidence.id)?.slice() ?? [],
    contradictions: contradictionsTouching(graph, { type: 'evidence', id: evidence.id }),
    provenance: traceProvenance(evidence, known),
  };
}

export function unknownsForClaim(graph: EvidenceGraph, claimId: string): UnknownRecord[] {
  return graph.unknownsByClaim.get(claimId)?.slice() ?? [];
}

export function contradictionsTouching(
  graph: EvidenceGraph,
  node: GraphNodeRef,
): ContradictionRecord[] {
  return graph.contradictionsByNode.get(nodeKey(node))?.slice() ?? [];
}

// -- Supersession ------------------------------------------------------------------------------

/**
 * The supersession chain of a claim, oldest to newest, and its current head. Single-successor
 * history is enforced by the database; if a damaged graph ever branched, the successor with the
 * lowest insertion sequence is followed, deterministically. Walks are bounded and cycle-safe.
 */
export function supersessionView(graph: EvidenceGraph, claimId: string): SupersessionView | null {
  const claim = graph.claims.get(claimId);
  if (!claim) return null;
  const limit = EVIDENCE_GRAPH_LIMITS.supersessionChainMax;

  const older: string[] = [];
  const seen = new Set<string>([claim.id]);
  for (let id = claim.supersedesId; id !== null && older.length < limit;) {
    if (seen.has(id) || !graph.claims.has(id)) break;
    seen.add(id);
    older.unshift(id);
    id = graph.claims.get(id)?.supersedesId ?? null;
  }
  const newer: string[] = [];
  for (let id = claim.id; newer.length < limit;) {
    const next = (graph.successorsOf.get(id) ?? [])[0];
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    newer.push(next.id);
    id = next.id;
  }
  const chain = [...older, claim.id, ...newer];
  const currentId = chain[chain.length - 1] ?? claim.id;
  const predecessorId =
    claim.supersedesId !== null && graph.claims.has(claim.supersedesId) ? claim.supersedesId : null;
  return {
    chain,
    predecessorId,
    successorId: newer[0] ?? null,
    currentId,
    isCurrent: currentId === claim.id,
  };
}

/** Claims that nothing supersedes, in insertion order. */
export function currentClaims(graph: EvidenceGraph): ClaimRecord[] {
  return graph.ordered.claims.filter((claim) => !graph.successorsOf.has(claim.id));
}

// -- Provenance --------------------------------------------------------------------------------

/**
 * EvidenceItem -> SourceSnapshot -> artifact -> span, as stored. `known` supplies the snapshot,
 * artifact and context-version facts; references it cannot resolve are reported in `issues`.
 */
export function traceProvenance(evidence: EvidenceRecord, known: KnownEntities): ProvenanceTrace {
  const { provenance } = evidence;
  const { issues } = checkProvenanceReferences(
    evidence,
    {
      snapshotId: provenance.snapshotId,
      artifactId: provenance.artifactId,
      span: provenance.span ? { start: provenance.span.start, end: provenance.span.end } : null,
      excerpt: provenance.excerpt,
      contextVersionId: provenance.contextVersionId,
    },
    known,
    { projectId: evidence.projectId, eventId: evidence.eventId },
  );
  const snapshot = provenance.snapshotId
    ? (known.snapshots.get(provenance.snapshotId) ?? null)
    : null;
  const artifactFacts = provenance.artifactId
    ? known.artifacts.get(provenance.artifactId)
    : undefined;
  const artifact = artifactFacts ? (({ slice: _slice, ...facts }) => facts)(artifactFacts) : null;
  const contextVersion = provenance.contextVersionId
    ? (known.contextVersions.get(provenance.contextVersionId) ?? null)
    : null;
  return {
    evidenceId: evidence.id,
    origin: evidence.origin,
    kind:
      provenance.snapshotId !== null
        ? 'source_snapshot'
        : provenance.contextVersionId !== null
          ? 'event_context_version'
          : 'none',
    snapshot,
    artifact,
    span: provenance.span,
    excerpt: provenance.excerpt,
    contextVersion,
    issues: issues.map((issue) => `${issue.code}: ${issue.message}`),
  };
}

// -- Neighbors ---------------------------------------------------------------------------------

const TYPE_ORDER: Record<GraphNodeRef['type'], number> = {
  claim: 0,
  evidence: 1,
  unknown: 2,
  contradiction: 3,
};

interface Adjacent {
  node: GraphNodeRef;
  seq: number;
  edge: Neighborhood['edges'][number];
}

function adjacent(graph: EvidenceGraph, node: GraphNodeRef): Adjacent[] {
  const result: Adjacent[] = [];
  const push = (
    target: GraphNodeRef,
    seq: number,
    kind: Neighborhood['edges'][number]['kind'],
    from: GraphNodeRef,
    to: GraphNodeRef,
    relationType: Neighborhood['edges'][number]['relationType'] = null,
  ) => result.push({ node: target, seq, edge: { kind, from, to, relationType } });

  switch (node.type) {
    case 'claim': {
      for (const relation of graph.relationsByClaim.get(node.id) ?? []) {
        const evidence = graph.evidence.get(relation.evidenceId);
        if (evidence) {
          const other: GraphNodeRef = { type: 'evidence', id: evidence.id };
          push(other, evidence.seq, 'relation', node, other, relation.type);
        }
      }
      for (const unknown of graph.unknownsByClaim.get(node.id) ?? []) {
        const other: GraphNodeRef = { type: 'unknown', id: unknown.id };
        push(other, unknown.seq, 'unknown_reference', other, node);
      }
      for (const contradiction of graph.contradictionsByNode.get(nodeKey(node)) ?? []) {
        const other: GraphNodeRef = { type: 'contradiction', id: contradiction.id };
        push(other, contradiction.seq, 'contradiction_side', other, node);
      }
      const claim = graph.claims.get(node.id);
      const predecessor = claim?.supersedesId ? graph.claims.get(claim.supersedesId) : undefined;
      if (predecessor) {
        const other: GraphNodeRef = { type: 'claim', id: predecessor.id };
        push(other, predecessor.seq, 'supersession', node, other);
      }
      for (const successor of graph.successorsOf.get(node.id) ?? []) {
        const other: GraphNodeRef = { type: 'claim', id: successor.id };
        push(other, successor.seq, 'supersession', other, node);
      }
      break;
    }
    case 'evidence': {
      for (const relation of graph.relationsByEvidence.get(node.id) ?? []) {
        const claim = graph.claims.get(relation.claimId);
        if (claim) {
          const other: GraphNodeRef = { type: 'claim', id: claim.id };
          push(other, claim.seq, 'relation', other, node, relation.type);
        }
      }
      for (const unknown of graph.unknownsByEvidence.get(node.id) ?? []) {
        const other: GraphNodeRef = { type: 'unknown', id: unknown.id };
        push(other, unknown.seq, 'unknown_reference', other, node);
      }
      for (const contradiction of graph.contradictionsByNode.get(nodeKey(node)) ?? []) {
        const other: GraphNodeRef = { type: 'contradiction', id: contradiction.id };
        push(other, contradiction.seq, 'contradiction_side', other, node);
      }
      break;
    }
    case 'unknown': {
      const unknown = graph.unknowns.get(node.id);
      for (const id of unknown?.claimIds ?? []) {
        const claim = graph.claims.get(id);
        if (claim) {
          const other: GraphNodeRef = { type: 'claim', id };
          push(other, claim.seq, 'unknown_reference', node, other);
        }
      }
      for (const id of unknown?.evidenceIds ?? []) {
        const evidence = graph.evidence.get(id);
        if (evidence) {
          const other: GraphNodeRef = { type: 'evidence', id };
          push(other, evidence.seq, 'unknown_reference', node, other);
        }
      }
      break;
    }
    case 'contradiction': {
      const contradiction = graph.contradictions.get(node.id);
      for (const side of contradiction ? [contradiction.sideA, contradiction.sideB] : []) {
        const target =
          side.type === 'claim' ? graph.claims.get(side.id) : graph.evidence.get(side.id);
        if (target) {
          const other: GraphNodeRef = { type: side.type, id: side.id };
          push(other, target.seq, 'contradiction_side', node, other);
        }
      }
      break;
    }
  }
  return result.sort(
    (a, b) =>
      TYPE_ORDER[a.node.type] - TYPE_ORDER[b.node.type] ||
      a.seq - b.seq ||
      compareStrings(a.node.id, b.node.id),
  );
}

function exists(graph: EvidenceGraph, node: GraphNodeRef): boolean {
  switch (node.type) {
    case 'claim':
      return graph.claims.has(node.id);
    case 'evidence':
      return graph.evidence.has(node.id);
    case 'unknown':
      return graph.unknowns.has(node.id);
    case 'contradiction':
      return graph.contradictions.has(node.id);
  }
}

/**
 * Breadth-first neighborhood of one node over every edge kind (relations, unknown references,
 * contradiction sides, supersession), treated as undirected for reachability. Bounded in depth
 * and node count, cycle-safe, and ordered deterministically (distance, type, insertion order).
 * Returns null if the start node does not exist.
 */
export function neighborhood(
  graph: EvidenceGraph,
  start: GraphNodeRef,
  options: { depth?: number; maxNodes?: number } = {},
): Neighborhood | null {
  if (!exists(graph, start)) return null;
  const depth = Math.max(0, Math.min(options.depth ?? 1, EVIDENCE_GRAPH_LIMITS.traversalMaxDepth));
  const maxNodes = Math.max(
    1,
    Math.min(
      options.maxNodes ?? EVIDENCE_GRAPH_LIMITS.traversalMaxNodes,
      EVIDENCE_GRAPH_LIMITS.traversalMaxNodes,
    ),
  );

  const distance = new Map<string, number>([[nodeKey(start), 0]]);
  const nodes: Neighborhood['nodes'] = [{ ...start, distance: 0 }];
  const edges = new Map<string, Neighborhood['edges'][number]>();
  let frontier: GraphNodeRef[] = [start];
  let truncated = false;

  for (let level = 1; level <= depth && frontier.length > 0 && !truncated; level += 1) {
    const next: GraphNodeRef[] = [];
    for (const node of frontier) {
      for (const { node: other, edge } of adjacent(graph, node)) {
        const key = nodeKey(other);
        if (!distance.has(key)) {
          if (nodes.length >= maxNodes) {
            truncated = true;
            continue;
          }
          distance.set(key, level);
          nodes.push({ ...other, distance: level });
          next.push(other);
        }
        edges.set(`${nodeKey(edge.from)}>${edge.kind}>${nodeKey(edge.to)}`, edge);
      }
    }
    frontier = next;
  }
  // Keep only edges whose endpoints were both reached.
  const kept = [...edges.entries()]
    .filter(([, edge]) => distance.has(nodeKey(edge.from)) && distance.has(nodeKey(edge.to)))
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([, edge]) => edge);
  return { start, depth, nodes, edges: kept, truncated };
}

// -- Summary (no scores) -----------------------------------------------------------------------

function counted<T extends string>(values: readonly T[], observed: readonly T[]) {
  const counts = new Map<T, number>();
  for (const value of observed) counts.set(value, (counts.get(value) ?? 0) + 1);
  return values.map((value) => ({ value, count: counts.get(value) ?? 0 }));
}

/** Plain counts per vocabulary value (zeros included). Never a score, strength or coverage. */
export function summarizeGraph(projectId: string, graph: EvidenceGraph): EvidenceGraphSummary {
  const { claims, evidence, relations, unknowns, contradictions } = graph.ordered;
  const current = currentClaims(graph).length;
  return {
    projectId,
    claims: {
      total: claims.length,
      current,
      superseded: claims.length - current,
      byVerificationLevel: counted(
        VERIFICATION_LEVEL_VALUES,
        claims.map((claim) => claim.verificationLevel),
      ),
    },
    evidence: {
      total: evidence.length,
      byKind: counted(
        EVIDENCE_KIND_VALUES,
        evidence.map((item) => item.kind),
      ),
      byOrigin: counted(
        EVIDENCE_ORIGIN_VALUES,
        evidence.map((item) => item.origin),
      ),
      byVerificationLevel: counted(
        VERIFICATION_LEVEL_VALUES,
        evidence.map((item) => item.verificationLevel),
      ),
    },
    relations: {
      total: relations.length,
      byType: counted(
        EVIDENCE_RELATION_TYPE_VALUES,
        relations.map((relation) => relation.type),
      ),
    },
    unknowns: {
      total: unknowns.length,
      byType: counted(
        UNKNOWN_TYPE_VALUES,
        unknowns.map((unknown) => unknown.unknownType),
      ),
    },
    contradictions: { total: contradictions.length },
  };
}

// -- Pagination --------------------------------------------------------------------------------

/** Keyset page over insertion order: records with `seq > after`, at most `limit`. */
export function paginate<T extends { seq: number; id: string }>(
  records: readonly T[],
  { limit, after }: { limit: number; after: number },
): { items: T[]; nextAfter: number | null } {
  const sorted = [...records].sort(compareBySeq).filter((record) => record.seq > after);
  const items = sorted.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextAfter: sorted.length > limit && last ? last.seq : null };
}
