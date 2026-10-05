import type { ClaimRecord, EvidenceRecord, RelationRecord } from '@judge-copilot/schemas';
import type { EvidenceGraph } from './graph.js';
import { canonicalSides, nodeKey, relationPairKey } from './graph.js';
import { compareStrings, sortIssues, type GraphIssue } from './issues.js';
import type { KnownEntities } from './known.js';
import { checkProvenanceReferences, checkProvenanceShape } from './provenance.js';
import {
  canEvidenceKindBeContradictionSide,
  canEvidenceKindTakePart,
  claimLevelJustification,
  isVerificationTransitionAllowed,
  type JustifyingEvidence,
} from './verification.js';

/*
 * Pure validation of a loaded graph (and the shared rule helpers the batch planner reuses).
 * It is the "no dangling / no cross-project" audit: every reference must resolve inside the graph,
 * to the right kind of entity, in the same project, and every record must satisfy the domain
 * rules. A graph written through the trusted write path always passes; this proves it, and
 * catches anything that bypassed it.
 */

// -- Shared rule helpers ---------------------------------------------------------------------

/** Returns an issue message when a claim at `level` lacks the graph material it needs. */
export function justificationProblem(
  level: ClaimRecord['verificationLevel'],
  supporting: readonly JustifyingEvidence[],
  hasContradiction: boolean,
): string | null {
  const need = claimLevelJustification(level);
  switch (need.kind) {
    case 'none':
      return null;
    case 'supporting_evidence':
      return supporting.some(need.accepts)
        ? null
        : `Verification level ${level} needs ${need.describe}`;
    case 'contradiction_record':
      return hasContradiction
        ? null
        : 'Verification level contradicted needs a Contradiction record with this claim as a side';
  }
}

export function transitionProblem(
  from: ClaimRecord['verificationLevel'],
  to: ClaimRecord['verificationLevel'],
): string | null {
  return isVerificationTransitionAllowed(from, to)
    ? null
    : `A claim cannot move from ${from} to ${to} (verification never silently drops)`;
}

export function relationKindProblem(
  type: RelationRecord['type'],
  kind: EvidenceRecord['kind'],
): string | null {
  return canEvidenceKindTakePart(type, kind)
    ? null
    : `${kind} evidence cannot ${type === 'supports' ? 'support' : 'contradict'} a claim (missing evidence is not negative evidence)`;
}

export function contradictionSideKindProblem(kind: EvidenceRecord['kind']): string | null {
  return canEvidenceKindBeContradictionSide(kind)
    ? null
    : `${kind} evidence cannot be a side of a contradiction (missing evidence is not negative evidence)`;
}

// -- Loaded-graph validation -------------------------------------------------------------------

/**
 * Validates every record of `graph`. `known` supplies the source facts (snapshots, artifacts,
 * context versions) that provenance points at; without it, provenance lookups are skipped and only
 * provenance SHAPE is checked.
 */
export function validateGraphIntegrity(
  graph: EvidenceGraph,
  known: KnownEntities | null = null,
): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const add = (code: GraphIssue['code'], path: string, message: string) =>
    issues.push({ code, path, message });

  // Claims: supersession identity, cycles, branching.
  for (const claim of graph.ordered.claims) {
    const path = `claim:${claim.id}`;
    if (claim.supersedesId !== null) {
      const predecessor = graph.claims.get(claim.supersedesId);
      if (!predecessor) {
        add('DANGLING_REFERENCE', path, 'The superseded claim does not exist');
      } else if (predecessor.projectId !== claim.projectId) {
        add('CROSS_PROJECT_REFERENCE', path, 'A claim cannot supersede a claim of another project');
      } else if (claim.supersedesId === claim.id) {
        add('SUPERSESSION_CYCLE', path, 'A claim cannot supersede itself');
      } else {
        const problem = transitionProblem(predecessor.verificationLevel, claim.verificationLevel);
        if (problem) add('INVALID_VERIFICATION_TRANSITION', path, problem);
      }
    }
    const successors = graph.successorsOf.get(claim.id) ?? [];
    if (successors.length > 1) {
      add('CLAIM_ALREADY_SUPERSEDED', path, 'A claim has more than one successor');
    }
    if (hasSupersessionCycle(graph, claim.id)) {
      add('SUPERSESSION_CYCLE', path, 'The supersession chain contains a cycle');
    }

    const supporting: JustifyingEvidence[] = [];
    for (const relation of graph.relationsByClaim.get(claim.id) ?? []) {
      const evidence = graph.evidence.get(relation.evidenceId);
      if (relation.type === 'supports' && evidence) supporting.push(evidence);
    }
    const problem = justificationProblem(
      claim.verificationLevel,
      supporting,
      (graph.contradictionsByNode.get(nodeKey({ type: 'claim', id: claim.id })) ?? []).length > 0,
    );
    if (problem) add('UNJUSTIFIED_VERIFICATION', path, problem);
  }

  // Evidence: matrix, provenance shape and references.
  for (const evidence of graph.ordered.evidence) {
    const path = `evidence:${evidence.id}`;
    const provenance = {
      snapshotId: evidence.provenance.snapshotId,
      artifactId: evidence.provenance.artifactId,
      span: evidence.provenance.span
        ? { start: evidence.provenance.span.start, end: evidence.provenance.span.end }
        : null,
      excerpt: evidence.provenance.excerpt,
      contextVersionId: evidence.provenance.contextVersionId,
    };
    for (const issue of checkProvenanceShape(evidence, provenance)) {
      add(issue.code, `${path}.${issue.field}`, issue.message);
    }
    if (known) {
      const { issues: referenceIssues } = checkProvenanceReferences(evidence, provenance, known, {
        projectId: evidence.projectId,
        eventId: evidence.eventId,
      });
      for (const issue of referenceIssues) add(issue.code, `${path}.${issue.field}`, issue.message);
    }
  }

  // Relations.
  const seenPairs = new Map<string, RelationRecord>();
  for (const relation of graph.ordered.relations) {
    const path = `relation:${relation.id}`;
    const claim = graph.claims.get(relation.claimId);
    const evidence = graph.evidence.get(relation.evidenceId);
    if (!claim) add('DANGLING_REFERENCE', path, 'The related claim does not exist');
    else if (claim.projectId !== relation.projectId) {
      add('CROSS_PROJECT_REFERENCE', path, 'The relation crosses projects (claim side)');
    }
    if (!evidence) add('DANGLING_REFERENCE', path, 'The related evidence item does not exist');
    else {
      if (evidence.projectId !== relation.projectId) {
        add('CROSS_PROJECT_REFERENCE', path, 'The relation crosses projects (evidence side)');
      }
      const problem = relationKindProblem(relation.type, evidence.kind);
      if (problem) add('RELATION_KIND_NOT_ALLOWED', path, problem);
    }
    const key = relationPairKey(relation.claimId, relation.evidenceId);
    const previous = seenPairs.get(key);
    if (previous) {
      add(
        previous.type === relation.type ? 'DUPLICATE_RELATION' : 'CONFLICTING_RELATION',
        path,
        'The claim and evidence item are already related',
      );
    } else {
      seenPairs.set(key, relation);
    }
  }

  // Unknowns.
  for (const unknown of graph.ordered.unknowns) {
    const path = `unknown:${unknown.id}`;
    for (const [ids, map, label] of [
      [unknown.claimIds, graph.claims, 'claim'],
      [unknown.evidenceIds, graph.evidence, 'evidence item'],
    ] as const) {
      if (new Set(ids).size !== ids.length) {
        add('DUPLICATE_REFERENCE', path, `An unknown lists the same ${label} twice`);
      }
      for (const id of ids) {
        const target = map.get(id);
        if (!target) add('DANGLING_REFERENCE', path, `A referenced ${label} does not exist`);
        else if (target.projectId !== unknown.projectId) {
          add('CROSS_PROJECT_REFERENCE', path, `A referenced ${label} belongs to another project`);
        }
      }
    }
  }

  // Contradictions.
  const seenContradictions = new Set<string>();
  for (const contradiction of graph.ordered.contradictions) {
    const path = `contradiction:${contradiction.id}`;
    const a = contradiction.sideA;
    const b = contradiction.sideB;
    if (nodeKey(a) === nodeKey(b)) {
      add('CONTRADICTION_SAME_SIDE', path, 'A contradiction needs two distinct sides');
    }
    if (compareStrings(nodeKey(a), nodeKey(b)) > 0) {
      add('DUPLICATE_CONTRADICTION', path, 'The sides are not in canonical order');
    }
    for (const side of [a, b]) {
      const target =
        side.type === 'claim' ? graph.claims.get(side.id) : graph.evidence.get(side.id);
      if (!target) {
        add('DANGLING_REFERENCE', path, `A contradiction side (${side.type}) does not exist`);
        continue;
      }
      if (target.projectId !== contradiction.projectId) {
        add(
          'CROSS_PROJECT_REFERENCE',
          path,
          `A contradiction side (${side.type}) belongs to another project`,
        );
      }
      if (side.type === 'evidence') {
        const problem = contradictionSideKindProblem((target as EvidenceRecord).kind);
        if (problem) add('CONTRADICTION_KIND_NOT_ALLOWED', path, problem);
      }
    }
    const [x, y] = canonicalSides(a, b);
    const key = `${nodeKey(x)}|${nodeKey(y)}`;
    if (seenContradictions.has(key)) {
      add('DUPLICATE_CONTRADICTION', path, 'This pair of sides is already recorded');
    }
    seenContradictions.add(key);
  }
  return sortIssues(issues);
}

function hasSupersessionCycle(graph: EvidenceGraph, start: string): boolean {
  const seen = new Set<string>();
  let current: string | null = start;
  while (current !== null) {
    if (seen.has(current)) return true;
    seen.add(current);
    current = graph.claims.get(current)?.supersedesId ?? null;
  }
  return false;
}
