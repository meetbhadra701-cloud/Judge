import { nodeKey, supersessionView, type EvidenceGraph } from '@judge-copilot/evidence';
import type { ClaimLineage } from '@judge-copilot/schemas';
import { compareText } from './canonical.js';

/*
 * Claim lineage and contradiction mapping.
 *
 * A contradiction is MAPPED to a dimension when one of its sides is
 *   - an evidence item the dimension cites, or
 *   - a claim related (by `supports` or `contradicts`) to a cited evidence item, or any member of
 *     that claim's supersession chain.
 * A producer-written successor therefore cannot launder a contradiction attached to an earlier
 * claim of the chain (M4 design F5). There is no "resolved" state in M3, so a mapped contradiction
 * always counts, as UNCERTAINTY (a confidence factor), never as a score deduction.
 *
 * Only contradictions RECORDED in the graph can be counted. The engine cannot know about ones nobody
 * recorded, so it never claims completeness; recorded contradictions that map to no dimension are
 * reported, not dropped.
 */

export interface DimensionMapping {
  /** Claims related to the cited evidence, plus every member of their supersession chains. */
  readonly claimIds: ReadonlySet<string>;
  /** Distinct contradiction IDs touching the cited evidence or those claims, sorted. */
  readonly contradictionIds: readonly string[];
  /** Distinct unknown IDs referencing the cited evidence or those claims, sorted. */
  readonly unknownIds: readonly string[];
}

export function mapCitedEvidence(
  graph: EvidenceGraph,
  citedEvidenceIds: readonly string[],
): DimensionMapping {
  const claimIds = new Set<string>();
  for (const evidenceId of citedEvidenceIds) {
    for (const relation of graph.relationsByEvidence.get(evidenceId) ?? []) {
      for (const memberId of supersessionView(graph, relation.claimId)?.chain ?? [
        relation.claimId,
      ]) {
        claimIds.add(memberId);
      }
    }
  }

  const contradictions = new Set<string>();
  const unknowns = new Set<string>();
  for (const evidenceId of citedEvidenceIds) {
    for (const record of graph.contradictionsByNode.get(
      nodeKey({ type: 'evidence', id: evidenceId }),
    ) ?? []) {
      contradictions.add(record.id);
    }
    for (const record of graph.unknownsByEvidence.get(evidenceId) ?? []) unknowns.add(record.id);
  }
  for (const claimId of claimIds) {
    for (const record of graph.contradictionsByNode.get(nodeKey({ type: 'claim', id: claimId })) ??
      []) {
      contradictions.add(record.id);
    }
    for (const record of graph.unknownsByClaim.get(claimId) ?? []) unknowns.add(record.id);
  }

  return {
    claimIds,
    contradictionIds: [...contradictions].sort(compareText),
    unknownIds: [...unknowns].sort(compareText),
  };
}

/** The lineage of the supersession chain containing `claimId`. Labels are shown, never trusted. */
export function lineageOf(graph: EvidenceGraph, claimId: string): ClaimLineage | null {
  const view = supersessionView(graph, claimId);
  if (!view) return null;
  const members = view.chain;
  const contradictionIds = new Set<string>();
  for (const memberId of members) {
    for (const record of graph.contradictionsByNode.get(nodeKey({ type: 'claim', id: memberId })) ??
      []) {
      contradictionIds.add(record.id);
    }
  }
  const recordedLevels = members.map(
    (memberId) => graph.claims.get(memberId)?.verificationLevel ?? 'unverified',
  );
  return {
    headClaimId: view.currentId,
    claimIds: [...members],
    recordedLevels,
    everContradicted: contradictionIds.size > 0 || recordedLevels.includes('contradicted'),
    contradictionIds: [...contradictionIds].sort(compareText),
  };
}
